// The 404 sweep as a resumable job.
//
// A whole-site pass reads 165 blogs, 392 landing pages and 22 announcements from a CMS that must be
// spoken to one request at a time, so it runs for the better part of an hour. That does not fit in a
// serverless request, and it must survive being interrupted. So the run is a small state machine in
// Redis that does as much as fits in one chunk and then asks QStash to call it again.
//
// Phases: inventory -> scanning -> checking -> planned. Applying is a separate, explicit step:
// detection never implies repair, because repair edits live pages.
import { randomUUID } from "crypto";
import { redis } from "@/lib/redis";
import { qstashPublish, isServerless } from "@/lib/qstash";
import { buildInventory, fetchEntry, publicUrl, type Inventory, type EntryState } from "./sources";
import { extractLinks } from "./extract";
import { classifyOffline, probe, judgeProbe } from "./classify";
import { buildPlan } from "./plan";
import { applyFixes } from "./apply";
import { strapiReady } from "./strapiRaw";
import type { FoundLink, LinkFixState, PlannedFix, Surface } from "./types";

const STATE_KEY = "linkfix:state";
const FINDINGS_KEY = "linkfix:findings";
const PLAN_KEY = "linkfix:plan";
const QUEUE_KEY = "linkfix:queue";
const PROBE_KEY = "linkfix:probes";
const APPLIED_KEY = "linkfix:applied";
const STOP_KEY = "linkfix:stop";

/** Leave headroom under the platform limit so a chunk always gets to save its state. */
const CHUNK_BUDGET_MS = isServerless() ? 210_000 : 15 * 60_000;
const MAX_LOG = 80;

type Queue = { surface: Surface; id: number }[];

function r() {
  const c = redis();
  if (!c) throw new Error("Redis is not configured; the 404 sweep needs it to hold run state.");
  return c;
}

async function getState(): Promise<LinkFixState | null> {
  return ((await r().get(STATE_KEY)) as LinkFixState | null) ?? null;
}
async function putState(s: LinkFixState): Promise<void> {
  s.updatedAt = Date.now();
  await r().set(STATE_KEY, s);
}
function log(s: LinkFixState, line: string) {
  s.log ??= [];
  s.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
}

export async function getLinkFixState(): Promise<LinkFixState | null> {
  return getState();
}
export async function getFindings(): Promise<FoundLink[]> {
  return ((await r().get(FINDINGS_KEY)) as FoundLink[] | null) ?? [];
}
export async function getPlan(): Promise<{ fixes: PlannedFix[]; unfixable: PlannedFix[] }> {
  return ((await r().get(PLAN_KEY)) as { fixes: PlannedFix[]; unfixable: PlannedFix[] } | null) ?? { fixes: [], unfixable: [] };
}
export async function requestStop(): Promise<void> {
  await r().set(STOP_KEY, "1", { ex: 3600 });
}
async function stopRequested(): Promise<boolean> {
  const v = await r().get(STOP_KEY);
  if (v) { await r().del(STOP_KEY); return true; }
  return false;
}

export async function startSweep(): Promise<{ runId: string } | { error: string }> {
  if (!strapiReady()) return { error: "STRAPI_URL / STRAPI_API_TOKEN are not set." };
  const existing = await getState();
  if (existing && !["done", "error", "idle"].includes(existing.phase)) {
    return { error: `A sweep is already ${existing.phase}. Stop it first.` };
  }
  const state: LinkFixState = {
    runId: randomUUID(),
    phase: "inventory",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    counts: { pagesScanned: 0, linksFound: 0, ok: 0, broken: 0, dashboard: 0, assets: 0, blocked: 0 },
    cursor: 0,
    total: 0,
    log: [],
    dryRun: true,
  };
  log(state, "sweep started");
  await r().del(FINDINGS_KEY);
  await r().del(PLAN_KEY);
  await r().del(APPLIED_KEY);
  await r().del(PROBE_KEY);
  await putState(state);
  await kick();
  return { runId: state.runId };
}

async function kick(): Promise<void> {
  await qstashPublish("/api/link-fix/run", { continue: true });
}

/** One unit of work. Safe to call repeatedly; it picks up wherever the last chunk stopped. */
export async function processChunk(): Promise<void> {
  const state = await getState();
  if (!state || ["done", "error", "idle"].includes(state.phase)) return;
  const deadline = Date.now() + CHUNK_BUDGET_MS;

  if (await stopRequested()) {
    state.phase = "done";
    log(state, "stopped by request");
    await putState(state);
    return;
  }

  try {
    if (state.phase === "inventory") {
      const inv = await buildInventory();
      if ("error" in inv) throw new Error(inv.error);
      const queue: Queue = [
        ...inv.liveIds.blog.map((id) => ({ surface: "blog" as const, id })),
        ...inv.liveIds.announcement.map((id) => ({ surface: "announcement" as const, id })),
        ...inv.liveIds.landing.map((id) => ({ surface: "landing" as const, id })),
      ];
      await r().set(QUEUE_KEY, queue);
      await saveInventory(inv);
      state.phase = "scanning";
      state.cursor = 0;
      state.total = queue.length;
      log(state, `inventory: ${inv.liveIds.blog.length} blogs, ${inv.liveIds.landing.length} landing pages, ${inv.liveIds.announcement.length} announcements`);
      await putState(state);
      await kick();
      return;
    }

    if (state.phase === "scanning") {
      const inv = await loadInventory();
      const queue = ((await r().get(QUEUE_KEY)) as Queue | null) ?? [];
      const findings = await getFindings();

      while (state.cursor < queue.length && Date.now() < deadline) {
        const { surface, id } = queue[state.cursor];
        const got = await fetchEntry(surface, id);
        if (got.ok) {
          const slug = String(got.attrs.slug ?? "");
          const ctx = { surface, entryId: id, slug, pageUrl: publicUrl(inv, surface, slug) };
          const links = extractLinks(ctx, surface, got.attrs).map((l) => classifyOffline(l, inv));
          state.counts.linksFound += links.length;
          for (const l of links) {
            if (l.verdict === "ok") state.counts.ok++;
            else if (l.verdict === "asset") state.counts.assets++;
            // Everything actionable or still open is kept; "ok" and assets are counted only, which
            // is what keeps the stored findings small enough to live in Redis.
            else findings.push(l);
          }
          state.counts.pagesScanned++;
        } else {
          log(state, `skip ${surface}:${id} — ${got.error}`);
        }
        state.cursor++;
      }

      await r().set(FINDINGS_KEY, findings);
      if (state.cursor >= queue.length) {
        const open = [...new Set(findings.filter((f) => f.verdict === "unchecked" && f.target).map((f) => f.target!))];
        await r().set(QUEUE_KEY, open);
        state.phase = "checking";
        state.cursor = 0;
        state.total = open.length;
        log(state, `scanned ${state.counts.pagesScanned} pages, ${state.counts.linksFound} links; ${open.length} URLs need an HTTP check`);
      } else {
        log(state, `scanning ${state.cursor}/${queue.length}`);
      }
      await putState(state);
      await kick();
      return;
    }

    if (state.phase === "checking") {
      const open = ((await r().get(QUEUE_KEY)) as string[] | null) ?? [];
      const cache = ((await r().get(PROBE_KEY)) as Record<string, { verdict: string; why?: string; status: number }> | null) ?? {};

      // External hosts are unrelated to each other and to our CMS, so this is the one place a little
      // concurrency is both safe and worth it.
      const LANE = 5;
      while (state.cursor < open.length && Date.now() < deadline) {
        const batch = open.slice(state.cursor, state.cursor + LANE);
        await Promise.all(batch.map(async (url) => {
          if (cache[url]) return;
          const j = judgeProbe(await probe(url));
          cache[url] = { verdict: j.verdict, why: j.why, status: 0 };
        }));
        state.cursor += batch.length;
      }
      await r().set(PROBE_KEY, cache);

      if (state.cursor >= open.length) {
        const findings = await getFindings();
        for (const f of findings) {
          if (f.verdict !== "unchecked") continue;
          const hit = f.target ? cache[f.target] : undefined;
          if (!hit) { f.verdict = "ok"; continue; }
          f.verdict = hit.verdict as FoundLink["verdict"];
          f.why = hit.why ?? f.why;
        }
        state.counts.broken = findings.filter((f) => f.verdict === "broken").length;
        state.counts.dashboard = findings.filter((f) => f.verdict === "dashboard").length;
        state.counts.blocked = findings.filter((f) => f.verdict === "blocked").length;
        await r().set(FINDINGS_KEY, findings);

        const inv = await loadInventory();
        const plan = buildPlan(findings, inv);
        await r().set(PLAN_KEY, plan);
        state.phase = "planned";
        state.total = plan.fixes.length;
        state.cursor = 0;
        log(state, `${state.counts.broken} broken, ${state.counts.dashboard} dashboard; ${plan.fixes.length} fixes planned, ${plan.unfixable.length} need a person`);
      } else {
        log(state, `checking ${state.cursor}/${open.length}`);
      }
      await putState(state);
      await kick();
      return;
    }

    if (state.phase === "applying") {
      const inv = await loadInventory();
      const { fixes } = await getPlan();
      const doneKeys = new Set(((await r().get(APPLIED_KEY)) as string[] | null) ?? []);
      const before = doneKeys.size;
      const outcome = await applyFixes(fixes, inv, { deadline, done: doneKeys });
      await r().set(APPLIED_KEY, [...doneKeys]);

      const prev = state.applied ?? { pages: 0, edits: 0, removed: 0, failed: 0, at: Date.now() };
      state.applied = {
        pages: prev.pages + outcome.pages,
        edits: prev.edits + outcome.edits,
        removed: prev.removed + outcome.removed,
        failed: prev.failed + outcome.failed,
        at: Date.now(),
      };
      const totalEntries = new Set(fixes.map((f) => `${f.surface}:${f.entryId}`)).size;
      state.cursor = doneKeys.size;
      state.total = totalEntries;

      if (doneKeys.size >= totalEntries || doneKeys.size === before) {
        state.phase = "done";
        log(state, `applied: ${state.applied.pages} pages, ${state.applied.edits} edits, ${state.applied.removed} items removed, ${state.applied.failed} failed`);
        await putState(state);
        return;
      }
      log(state, `applying ${doneKeys.size}/${totalEntries} pages`);
      await putState(state);
      await kick();
      return;
    }
  } catch (e) {
    state.phase = "error";
    state.error = String((e as Error)?.message ?? e).slice(0, 300);
    log(state, `error: ${state.error}`);
    await putState(state);
  }
}

/** Begin writing the planned fixes. Separate from detection on purpose. */
export async function startApply(): Promise<{ ok: true; pages: number } | { error: string }> {
  const state = await getState();
  if (!state) return { error: "No sweep has been run yet." };
  if (state.phase !== "planned") return { error: `The sweep is ${state.phase}; fixes can only be applied from 'planned'.` };
  const { fixes } = await getPlan();
  if (!fixes.length) return { error: "Nothing to fix — the plan is empty." };
  state.phase = "applying";
  state.dryRun = false;
  state.cursor = 0;
  state.total = new Set(fixes.map((f) => `${f.surface}:${f.entryId}`)).size;
  log(state, `applying ${fixes.length} fixes across ${state.total} pages`);
  await putState(state);
  await kick();
  return { ok: true, pages: state.total };
}

// The inventory holds Sets and Maps, which JSON cannot carry; store the plain parts and rebuild.
async function saveInventory(inv: Inventory): Promise<void> {
  await r().set("linkfix:inv", {
    fetchedAt: inv.fetchedAt,
    livePaths: [...inv.livePaths],
    pathBySlug: [...inv.pathBySlug],
    blogs: [...inv.blogs],
    landings: [...inv.landings],
    liveIds: inv.liveIds,
  });
}
async function loadInventory(): Promise<Inventory> {
  const raw = (await r().get("linkfix:inv")) as {
    fetchedAt: number; livePaths: string[]; pathBySlug: [string, string][];
    blogs: [string, EntryState][]; landings: [string, EntryState][]; liveIds: Inventory["liveIds"];
  } | null;
  if (!raw) throw new Error("Inventory is missing; start the sweep again.");
  const blogs = new Map<string, EntryState>(raw.blogs);
  return {
    fetchedAt: raw.fetchedAt,
    livePaths: new Set<string>(raw.livePaths),
    pathBySlug: new Map<string, string>(raw.pathBySlug),
    blogs,
    landings: new Map<string, EntryState>(raw.landings),
    blogById: new Map<number, EntryState>([...blogs.values()].map((b) => [b.id, b])),
    liveIds: raw.liveIds,
  };
}
