// The JS-injected-link detector: which links exist on a page ONLY after JavaScript runs?
//
// The crawler, Googlebot's first wave, and every AI crawler read raw HTML. A link a React
// component injects client-side is invisible to all of them — the page it points at may be
// perfectly healthy and still undiscoverable (the orphan-maker of roadmap 2.3). This
// detector executes each page's JavaScript in jsdom (a spec-compliant DOM in-process — the
// house renderer; Playwright/Chromium is deliberately NOT used here, it's unavailable in
// this deployment), reads anchors FROM THE DOM (`a.href`, DOM-resolved absolute — no HTML
// regex on the rendered side), fires scroll events and auto-triggers IntersectionObservers
// so lazy/viewport-injected content materializes, and diffs against the raw-HTML anchor set
// using the crawler's own extractor and the crawler's own URL normalizer. Every
// rendered-only same-site link is a finding; every one that is also BROKEN becomes a
// standard broken finding too — a dead link no crawler (including ours) could see until now.
//
// Effectiveness is enforced as honesty, not magic:
//   • A page that fails to execute is a counted `render-failed` finding, never a silent skip.
//   • The diff is conservative by construction (one shared normalizer, same-site filter,
//     query-insensitive), so a formatting difference can't masquerade as a hidden link.
//   • Fidelity boundary, stated: jsdom executes scripts but is not a pixel browser — a page
//     whose hydration depends on APIs jsdom lacks degrades to whatever DOM it built, and the
//     stubs below (matchMedia, IntersectionObserver, rAF/idle) exist to push that boundary
//     out. Executing site JS in-process is safe here because every page is our own.
//
// Long-job shape mirrors pages.ts: chunked, Redis state on its own keys, QStash-continued,
// results in the shared tables under kind='jslinks'.
import { supabaseAdmin } from "@/lib/db/supabase";
import { redis } from "@/lib/redis";
import { qstashPublish, isServerless } from "@/lib/qstash";
import { checkLink, extractLinks, fetchRaw, normalizeUrl, VERDICT_REASON, type FingerprintMap } from "@/lib/linkaudit/run";
import { enumeratePages } from "@/lib/linkaudit/pages";

const CHUNK_BUDGET_MS = isServerless() ? 210_000 : Infinity;
const RENDER_SETTLE_MS = 2_000; // hydration settle after scripts + DOMContentLoaded
const SCROLL_SETTLE_MS = 600;   // settle after dispatched scroll events
const RENDER_HARD_CAP_MS = 15_000; // absolute per-page budget, construction included
const MAX_JS_LINK_CHECKS = 40; // per page — a nav bar injected client-side is dozens of links

const STATE_KEY = "jslinks:state";
const STOP_KEY = "jslinks:stop";

export interface JsLinksState {
  runId: string;
  pages: string[];
  index: number;
  jsOnlyFound: number;
  brokenFound: number;
  renderFailed: number;
  log: string[];
  startedAt: number;
  updatedAt: number;
}

const MAX_LOG_LINES = 120;
function pushLog(state: JsLinksState, line: string) {
  state.log ??= [];
  state.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES);
}

// ─── Renderer (jsdom — in-process script execution, no browser binary) ────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// APIs bundles expect that jsdom doesn't ship. Each stub exists to keep hydration ALIVE
// (matchMedia throws-on-missing kills many bundles at boot) or to force lazy content to
// materialize (an IntersectionObserver that reports everything visible immediately is
// strictly more thorough than scrolling a viewport past it).
function installStubs(window: import("jsdom").DOMWindow): void {
  const w = window as unknown as Record<string, unknown>;
  if (!w.matchMedia) {
    w.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    });
  }
  w.scrollTo = () => {};
  w.scrollBy = () => {};
  if (!w.requestIdleCallback) {
    w.requestIdleCallback = (cb: (d: { didTimeout: boolean; timeRemaining: () => number }) => void) =>
      setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 1);
    w.cancelIdleCallback = (id: number) => clearTimeout(id);
  }
  if (!w.IntersectionObserver) {
    class EagerIO {
      private cb: (entries: unknown[], obs: unknown) => void;
      constructor(cb: (entries: unknown[], obs: unknown) => void) { this.cb = cb; }
      observe(target: unknown) {
        setTimeout(() => this.cb([{ isIntersecting: true, intersectionRatio: 1, target }], this), 1);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    }
    w.IntersectionObserver = EagerIO;
  }
  if (!w.ResizeObserver) {
    class NoopRO { observe() {} unobserve() {} disconnect() {} }
    w.ResizeObserver = NoopRO;
  }
}

// Anchors as the DOM resolves them after the page's own scripts have run — plus dispatched
// scroll events, because viewport-triggered injection (lazy related-posts, infinite-scroll
// teasers) is real and a detector that never "scrolls" misses it by design.
export async function extractRenderedAnchors(url: string, rawHtml?: string): Promise<{ hrefs: string[]; status: number } | null> {
  let html = rawHtml;
  let status = 200;
  if (html === undefined) {
    const res = await fetchRaw(url, 15_000);
    if ("error" in res || res.status !== 200 || !res.html) return null;
    html = res.html;
    status = res.status;
  }

  const { JSDOM, VirtualConsole } = await import("jsdom");
  // Site scripts log and throw freely under jsdom; none of it is our signal — swallow it.
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", () => {});

  let dom: import("jsdom").JSDOM | null = null;
  try {
    const work = (async () => {
      dom = new JSDOM(html!, {
        url,
        runScripts: "dangerously",           // our own pages only — that's what makes this safe
        resources: "usable",                 // external <script src> bundles load and execute
        pretendToBeVisual: true,             // rAF exists, so hydration loops can complete
        beforeParse: installStubs,
        virtualConsole,
      });
      const win = dom.window;
      await sleep(RENDER_SETTLE_MS);
      // "Scroll": fire the events; layout doesn't exist in jsdom, listeners do.
      try {
        for (let i = 0; i < 3; i++) {
          win.dispatchEvent(new win.Event("scroll"));
          await sleep(120);
        }
      } catch { /* a page that broke its window still yields its DOM below */ }
      await sleep(SCROLL_SETTLE_MS);
      return [...win.document.querySelectorAll("a[href]")].map((a) => (a as HTMLAnchorElement).href);
    })();
    const hrefs = await Promise.race([
      work,
      sleep(RENDER_HARD_CAP_MS).then(() => null),
    ]);
    if (hrefs === null) return null; // hard cap hit — render-failed, counted by the caller
    return { hrefs, status };
  } catch {
    return null;
  } finally {
    try { (dom as import("jsdom").JSDOM | null)?.window.close(); } catch { /* already dead */ }
  }
}

// Same site = same host (www-insensitive) or both under northwind.example. Rendered pages inject
// plenty of EXTERNAL links (consent managers, social widgets, embed chrome) — universal
// noise with no discovery consequence for OUR pages, so only same-site links are findings.
function sameSite(linkUrl: string, pageUrl: string): boolean {
  try {
    const l = new URL(linkUrl).host.replace(/^www\./, "");
    const p = new URL(pageUrl).host.replace(/^www\./, "");
    if (l === p) return true;
    const root = (h: string) => (h.endsWith("northwind.example") ? "northwind.example" : h);
    return root(l) === root(p) && root(l) === "northwind.example";
  } catch { return false; }
}

// The diff: same-site links present in the rendered DOM whose normalized form is absent
// from the raw-HTML anchor set. Pure given both inputs — exported for the E2E suite.
export function diffJsOnlyLinks(rawHtml: string, renderedHrefs: string[], pageUrl: string): string[] {
  const rawSet = new Set(extractLinks(rawHtml, pageUrl).map((l) => normalizeUrl(l.url)));
  const pageNorm = normalizeUrl(pageUrl);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const href of renderedHrefs) {
    if (!/^https?:/i.test(href)) continue;
    if (!sameSite(href, pageUrl)) continue;
    const norm = normalizeUrl(href);
    if (norm === pageNorm || rawSet.has(norm) || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

// ─── Stop flag + state ─────────────────────────────────────────────────────────────────────

export async function requestJsLinksStop(): Promise<void> {
  const r = redis();
  if (r) await r.set(STOP_KEY, "1", { ex: 3600 }).catch(() => {});
}
async function isStopRequested(): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  return !!(await r.get(STOP_KEY).catch(() => null));
}
async function clearStop(): Promise<void> {
  const r = redis();
  if (r) await r.del(STOP_KEY).catch(() => {});
}

export async function getJsLinksState(): Promise<JsLinksState | null> {
  const r = redis();
  if (!r) return null;
  const raw = await r.get<unknown>(STATE_KEY).catch(() => null);
  if (!raw) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as JsLinksState;
}
async function saveState(s: JsLinksState): Promise<void> {
  const r = redis();
  if (!r) return;
  s.updatedAt = Date.now();
  await r.set(STATE_KEY, JSON.stringify(s), { ex: 60 * 60 * 24 }).catch(() => {});
}
export async function clearJsLinksState(): Promise<void> {
  const r = redis();
  if (r) await r.del(STATE_KEY).catch(() => {});
}

// ─── Runner ────────────────────────────────────────────────────────────────────────────────

export async function startJsLinksRun(): Promise<{ runId: string; pagesTotal: number }> {
  const { pages, note } = await enumeratePages(false);
  if (pages.length === 0) throw new Error("No pages to render — is site_urls empty and the sitemap unreachable?");
  const { data: run, error } = await supabaseAdmin
    .from("link_audit_runs")
    .insert({ status: "running", pages_total: pages.length, kind: "jslinks" })
    .select()
    .single();
  if (error) throw error;
  await clearJsLinksState();
  const state: JsLinksState = {
    runId: run.id, pages, index: 0, jsOnlyFound: 0, brokenFound: 0, renderFailed: 0,
    log: [], startedAt: Date.now(), updatedAt: Date.now(),
  };
  pushLog(state, note);
  pushLog(state, `Executing ${pages.length} pages' JavaScript in jsdom to find links that only exist after it runs…`);
  await saveState(state);
  await clearStop();
  return { runId: run.id, pagesTotal: pages.length };
}

export async function processJsLinksChunk(): Promise<void> {
  const state = await getJsLinksState();
  if (!state) return;
  const deadline = Date.now() + CHUNK_BUDGET_MS;
  const fpCache: FingerprintMap = {};

  while (state.index < state.pages.length && Date.now() < deadline) {
    if (await isStopRequested()) {
      pushLog(state, `Stopped by user at ${state.index}/${state.pages.length} pages.`);
      await saveState(state);
      await supabaseAdmin.from("link_audit_runs").update({
        status: "stopped", finished_at: new Date().toISOString(),
        pages_checked: state.index, links_checked: state.jsOnlyFound,
        broken_found: state.brokenFound, unreachable: state.renderFailed,
      }).eq("id", state.runId);
      await clearJsLinksState();
      await clearStop();
      return;
    }

    const pageUrl = state.pages[state.index];
    const path = (() => { try { return new URL(pageUrl).pathname || "/"; } catch { return pageUrl; } })();
    // Raw first: no raw HTML means the page itself is unreachable right now — the page
    // sweep owns that problem; here it's a render-failed row so the count stays honest.
    const raw = await fetchRaw(pageUrl, 15_000);
    const rawOk = !("error" in raw) && raw.status === 200 ? raw : null;
    // The raw HTML is already in hand — jsdom executes over it directly, no second fetch.
    const rendered = rawOk ? await extractRenderedAnchors(pageUrl, rawOk.html) : null;

    if (!rawOk || !rendered) {
      state.renderFailed++;
      await supabaseAdmin.from("link_audit_findings").upsert([{
        run_id: state.runId, page_url: pageUrl, page_author: null,
        link_url: pageUrl, anchor_text: null, context_text: null,
        occurrences: [], location_hint: "couldn't render this page — its JS-only links (if any) are UNVERIFIED this run",
        reason: "render-failed", http_status: "error" in raw ? null : raw.status,
      }], { onConflict: "run_id,page_url,link_url", ignoreDuplicates: true });
      pushLog(state, `[${state.index + 1}/${state.pages.length}] ${path} — render failed (unverified, counted)`);
    } else {
      const jsOnly = diffJsOnlyLinks(rawOk.html, rendered.hrefs, pageUrl);
      const rows: Array<Record<string, unknown>> = [];
      for (const link of jsOnly.slice(0, MAX_JS_LINK_CHECKS)) {
        // Is the hidden link ALSO dead? Nobody — including our own crawler — could have
        // seen it before this render, so check it while we hold it. One row per link: a
        // broken hidden link files under its REAL broken reason (entering the standard
        // closure/diff pipeline), with the hint carrying the JS-injected part of the story.
        const v = await checkLink(link, fpCache);
        const brokenReason = VERDICT_REASON[v.verdict] ?? null;
        state.jsOnlyFound++;
        if (brokenReason) state.brokenFound++;
        rows.push({
          run_id: state.runId, page_url: pageUrl, page_author: null,
          link_url: link, anchor_text: null, context_text: null,
          occurrences: [],
          location_hint: brokenReason
            ? "JS-injected AND broken — dead, and no non-rendering crawler could even see it"
            : "this link only exists after JavaScript runs — invisible to Google's first crawl wave, every AI crawler, and the raw-HTML link audit",
          reason: brokenReason ?? "js-only-link", http_status: v.status ?? null,
        });
      }
      if (jsOnly.length > MAX_JS_LINK_CHECKS) {
        pushLog(state, `${path}: ${jsOnly.length} JS-only links — recorded the first ${MAX_JS_LINK_CHECKS} (page is heavily client-rendered)`);
      }
      if (rows.length > 0) {
        await supabaseAdmin.from("link_audit_findings").upsert(rows, { onConflict: "run_id,page_url,link_url", ignoreDuplicates: true });
      }
      pushLog(state, `[${state.index + 1}/${state.pages.length}] ${path} — ${jsOnly.length === 0 ? "no JS-only links" : `${jsOnly.length} JS-only link(s)${rows.length > jsOnly.length ? " · some BROKEN" : ""}`}`);
    }

    state.index++;
    if (state.index % 5 === 0 || state.index === state.pages.length) {
      await saveState(state);
      await supabaseAdmin.from("link_audit_runs").update({
        pages_checked: state.index, links_checked: state.jsOnlyFound,
        broken_found: state.brokenFound, unreachable: state.renderFailed,
      }).eq("id", state.runId);
    }
  }

  await saveState(state);

  if (state.index < state.pages.length) {
    pushLog(state, `Time budget reached — continuing in a fresh run (${state.pages.length - state.index} pages left)`);
    await saveState(state);
    await qstashPublish("/api/link-audit/jslinks/run", { continue: true, auto: true });
    return;
  }

  pushLog(state, `Detector complete — ${state.jsOnlyFound} JS-only link(s), ${state.brokenFound} of them broken, ${state.renderFailed} page(s) unrendered.`);
  await saveState(state);
  await supabaseAdmin.from("link_audit_runs").update({
    status: "completed", finished_at: new Date().toISOString(),
    pages_checked: state.index, links_checked: state.jsOnlyFound,
    broken_found: state.brokenFound, unreachable: state.renderFailed,
  }).eq("id", state.runId);

  try {
    const { postAuditDigest } = await import("./slack");
    await postAuditDigest(state.runId);
  } catch { /* digest failure shouldn't fail the run */ }

  await clearJsLinksState();
}
