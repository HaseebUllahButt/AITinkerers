// The daily sweep: find what happened, decide what it becomes, remember what is still undone.
//
// Built on the landing radar rather than beside it. runRadar() already sweeps HuggingFace uploads,
// first-party RSS and the vendor deprecation tables, already dates everything, and already runs the
// Strapi ledger over each candidate. Writing a second sweeper would mean two things to keep working
// and two answers to "have we covered this".
//
// ── The one thing this does that the radar does not ─────────────────────────────────────────────
//
// The radar DROPS anything that is not a landing page — gate 2, `pageTypeFor` returning null, and
// the count reported as `droppedIrrelevant`. That is correct for a board whose only job is to build
// a page. It is wrong here, because under the routing rule those dropped items are exactly the blog
// posts: everything gets a blog, and only a model also gets a page. So the sweep re-reads the raw
// candidates and routes them itself.
//
// ── Accumulating, not refreshing ────────────────────────────────────────────────────────────────
//
// Rows are upserted on their signature and `last_seen` moves; nothing is deleted. An item found on
// Monday and still open on Friday is the point of the surface. A person's decision (`status`) is
// never touched by a sweep — only `coverage`, which is a fact about the world and safe to re-derive.
import { supabaseAdmin } from "@/lib/db/supabase";
import { runRadar, type RadarCandidate } from "@/lib/research/radar";
import { ledgerCheck } from "@/lib/research/ledger";
import { routeCandidate } from "./route";
import { sweepSignals } from "./signals";

/**
 * Two kinds of row, and the board must never confuse them.
 *
 * `primary` carries a citable first-party source: a vendor deprecation table, a lab's own RSS, a
 * Hub upload. `signal` is Hacker News, Reddit or X — a POINTER at a primary source, often days
 * ahead of it, and never a citation in itself.
 *
 * Derived from source_kind rather than stored in its own column: the kind already says which one it
 * is, and a second column recording the same fact is a second thing to keep in sync.
 */
const SIGNAL_KINDS = new Set(["hackernews", "reddit", "x", "webresearch"]);
export function tierOf(sourceKind: string | null | undefined): "primary" | "signal" {
  return SIGNAL_KINDS.has(String(sourceKind)) ? "signal" : "primary";
}

/**
 * What belongs at the top when someone asks "anything coming up?".
 *
 * Lives here rather than in the /research route because it is now read by two callers, and the one
 * that did NOT have it demonstrated why: Summer's answer led with eight OpenAI API snapshot IDs
 * retiring next October, because a future retirement date is the largest number on the board. The
 * rank has to travel with the data, not with one surface.
 *
 * A vendor changelog or a first-party post is news. A retirement is dated and real but is a
 * migration note, not a launch. A Hub upload is the weakest evidence and the most numerous.
 */
const KIND_RANK: Record<string, number> = {
  changelog: 0,
  x: 1,
  webresearch: 2,
  hackernews: 3,
  deprecation: 4,
  reddit: 5,
  huggingface: 6,
};

export function rankByNewsworthiness<T extends { source_kind: string | null; item_date: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ra = KIND_RANK[a.source_kind ?? ""] ?? 9;
    const rb = KIND_RANK[b.source_kind ?? ""] ?? 9;
    if (ra !== rb) return ra - rb;
    // Newest first within a tier. Dates are YYYY-MM-DD so a string compare is a date compare.
    return (b.item_date ?? "").localeCompare(a.item_date ?? "");
  });
}

export interface SweepResult {
  swept: number;
  added: number;
  updated: number;
  covered: number;
  sources: { name: string; ok: boolean; count: number; note: string | null }[];
  notes: string[];
}

/** Meaningful tokens only, sorted — the same collapsing the brief script uses, so one release is one
 *  row however its name was written by the source that found it. */
const STOP = new Set(["ai", "the", "a", "an", "for", "with", "to", "of", "and", "new", "now",
  "introducing", "announcing", "available", "released", "release", "launch", "update", "updates"]);
const GENERIC = new Set(["model", "models", "image", "video", "audio", "preview", "api", "lora",
  "gguf", "fp8", "turbo", "comfyui", "workflow", "quantized", "base", "instruct", "v1", "v2",
  // Packaging, not identity. A real board showed `gooya-v1-ONNX-int4` and `gooya-v1-ONNX-fp16` as
  // two separate rows for one model — the signature kept the format token, so they never collapsed.
  // The source filter now drops most of these before they arrive; this is what catches the rest.
  "onnx", "ggml", "mlx", "awq", "gptq", "int4", "int8", "fp16", "bf16", "nf4",
  "q4", "q5", "q6", "q8", "4bit", "8bit", "distilled", "merged", "finetune", "finetuned"]);

export function signatureOf(s: string): string {
  const t = String(s).toLowerCase().replace(/[^a-z0-9.]+/g, " ").split(" ")
    .filter(Boolean).filter((w) => !STOP.has(w) && !GENERIC.has(w));
  return [...new Set(t)].sort().join("-");
}

/**
 * Is there already a page, or a draft in flight?
 *
 * Two questions with two different answers, and both matter. The ledger knows what Strapi and the
 * sitemap hold — including pages written by hand, by a teammate, or before this tool existed. The
 * local draft table knows what is being written right now, which the ledger cannot see until it
 * syncs. Checking only one of them means either re-offering finished work or re-offering work
 * somebody started this morning.
 */
async function coverageFor(subject: string, existing: { ledger: RadarCandidate["ledger"] }): Promise<{
  coverage: "covered" | "drafting" | "open";
  detail: string | null;
  draftId: string | null;
}> {
  // A draft whose title carries the subject's distinctive tokens. Cheap and imprecise on purpose:
  // this is a hint for a person reading the board, not a gate that blocks anything.
  const sig = signatureOf(subject);
  const firstToken = sig.split("-")[0];
  if (firstToken && firstToken.length > 2) {
    const { data } = await supabaseAdmin
      .from("blog_drafts")
      .select("id, title, sync_state")
      .ilike("title", `%${firstToken}%`)
      .limit(5);
    const hit = (data ?? []).find((d: { title: string }) => signatureOf(d.title).includes(firstToken));
    if (hit) {
      return {
        coverage: hit.sync_state === "published" ? "covered" : "drafting",
        detail: hit.sync_state === "published" ? "Published from a SearchOps draft." : `Draft in progress (${hit.sync_state}).`,
        draftId: hit.id,
      };
    }
  }

  const led = existing.ledger ?? (await ledgerCheck(subject).then((r) => r.verdict).catch(() => null));
  if (led && (led.verdict === "DUPLICATE" || led.verdict === "NEAR_DUPLICATE")) {
    // The ledger's own one-line note is written to be rendered on a card, so it is used rather than
    // rebuilt — it already says which page matched and how closely.
    const hit = led.exact[0] ?? led.near[0];
    return {
      coverage: "covered",
      detail: led.note || (hit ? `Already covered by /${hit.slug}.` : "Already covered per the ledger."),
      draftId: null,
    };
  }
  return { coverage: "open", detail: null, draftId: null };
}

/**
 * Run one sweep and persist it.
 *
 * Ledger checks are the expensive part — one Strapi round trip each — so they are bounded. Beyond
 * the cap an item is stored with coverage "open" and picked up by a later run rather than making the
 * whole sweep time out, and the cap is reported in `notes` rather than silently applied.
 */
export async function runSweep(opts: { days?: number; maxCoverageChecks?: number; budgetMs?: number } = {}): Promise<SweepResult> {
  const maxChecks = opts.maxCoverageChecks ?? 25;
  const days = opts.days ?? 7;
  /**
   * A wall clock, because the count cap alone was not a bound.
   *
   * The route dies at 300s. Two consecutive real runs took 63s and 418s with identical settings —
   * the variance is per-candidate Strapi ledger latency, which nothing here controls. A run that
   * overshoots does not degrade, it 504s, and the daily cron then fails silently on a slow morning.
   *
   * So coverage checks stop when the budget is gone and their items are stored `open` for the next
   * run, which is the same graceful outcome the count cap already produces. Sources are swept
   * first and are never skipped: finding the news is the job, and knowing whether we covered it is
   * the refinement.
   */
  const deadline = Date.now() + (opts.budgetMs ?? 210_000);

  // In parallel, and independently: a dead Apify token must not stop the radar, and a HuggingFace
  // outage must not cost us the HN rows. Each reports its own health into `sources`.
  const [sweep, signals] = await Promise.all([
    runRadar({ days }),
    sweepSignals(days).catch(() => ({ rows: [], sources: [] })),
  ]);

  const candidates = [...sweep.candidates, ...signals.rows];

  const out: SweepResult = {
    swept: candidates.length, added: 0, updated: 0, covered: 0,
    sources: [...sweep.sources, ...signals.sources]
      .map((s) => ({ name: s.name, ok: s.ok, count: s.count, note: s.note })),
    notes: [...sweep.notes],
  };
  if (sweep.ledgerError) out.notes.push(`Ledger unavailable this run: ${sweep.ledgerError}`);

  let checks = 0;
  for (const c of candidates) {
    // A signal is keyed on its POST, not its text.
    //
    // signatureOf() collapses a model NAME, which is stable — "FLUX.1-dev" is the same string every
    // sweep. A tweet's subject is its prose, and the moment the formatting changed (stripping the
    // trailing t.co link) every X row re-keyed and inserted a second copy of itself beside the
    // first. The post id cannot drift, so it is what identity should have been from the start.
    const signature = tierOf(c.sourceKind) === "signal"
      ? `${c.sourceKind}:${c.id}`
      : signatureOf(c.subject);
    if (!signature) continue;

    const verdict = routeCandidate({
      subject: c.subject,
      summary: c.summary,
      // The radar has already decided this one is a page type we ship; disagreeing here would put
      // two answers in the product for one question.
      // Deprecation rows are excluded from the hint. pageTypeFor("retirement") returns a comparison
      // page, which is true of a FAMILY being retired and false of each version string in the table —
      // and passing the hint made every one of them a high-confidence landing page.
      hostedHint: !!c.pageType && c.sourceKind !== "deprecation",
    });

    // Deprecation rows are model IDs, not releases, and the classifier cannot tell the difference —
    // "gpt-4-0613" and "o4-mini-2025-04-16" both read as LLMs and came back landing+blog at high
    // confidence. A first real sweep produced 114 rows, every one of them proposing a landing page,
    // and twenty of those were retiring API snapshots.
    //
    // The value in a retirement is the MIGRATION, and that is one comparison page for a family, not
    // a page per version string. So they stay on the board — somebody should know a model is going
    // away — as blog items flagged low, and a person promotes the one worth a page.
    if (c.sourceKind === "deprecation") {
      verdict.surfaces = ["blog"];
      verdict.confidence = "low";
      verdict.reason = "A retiring model ID from a vendor deprecation table. The migration is worth writing about; the version string is not a page.";
    }

    // A signal never carries high confidence, whatever the classifier made of its wording. The
    // headline "X launches the best open video model" reads as a confident landing-page candidate
    // to a regex, and it is somebody's phrasing of a thing nobody here has verified. Confidence on
    // this board means "how sure are we", and the honest answer for an unconfirmed post is: not.
    if (tierOf(c.sourceKind) === "signal") {
      verdict.confidence = "low";
      verdict.reason = `${verdict.reason} Unconfirmed — spotted on ${c.sourceName}. Find the vendor's own announcement before writing; the post is a pointer, not a citation.`;
    }

    let coverage: Awaited<ReturnType<typeof coverageFor>> = { coverage: "open", detail: null, draftId: null };
    if (checks < maxChecks && Date.now() < deadline) {
      checks++;
      coverage = await coverageFor(c.subject, { ledger: c.ledger });
    }
    if (coverage.coverage === "covered") out.covered++;

    const { data: existing } = await supabaseAdmin
      .from("research_items").select("id").eq("signature", signature).maybeSingle();

    const row = {
      signature,
      subject: c.subject,
      summary: c.summary,
      source_name: c.sourceName,
      source_url: c.sourceUrl,
      source_kind: c.sourceKind,
      item_date: c.date,
      date_kind: c.dateKind,
      modality: verdict.modality,
      surfaces: verdict.surfaces,
      is_model: verdict.isModel,
      route_reason: verdict.reason,
      route_confidence: verdict.confidence,
      coverage: coverage.coverage,
      coverage_detail: coverage.detail,
      draft_id: coverage.draftId,
      last_seen: new Date().toISOString(),
    };

    if (existing) {
      // status and dismissed_reason are absent from the patch ON PURPOSE: they hold a person's
      // decision, and a sweep that overwrote them would ask the same question every morning.
      await supabaseAdmin.from("research_items").update(row).eq("id", existing.id);
      out.updated++;
    } else {
      await supabaseAdmin.from("research_items").insert(row);
      out.added++;
    }
  }

  if (Date.now() >= deadline) {
    // Reported, not silent. A run that quietly stopped checking coverage looks identical to one
    // where nothing was covered, and only one of those means "look again tomorrow".
    out.notes.push(
      `Ran out of time after ${checks} coverage check(s) — every source was swept and every row saved, ` +
        "but the rest are stored as open and re-checked next run.",
    );
  } else if (checks >= maxChecks && candidates.length > maxChecks) {
    out.notes.push(
      `Coverage checked for ${maxChecks} of ${candidates.length} candidates this run; the rest are stored as open and checked next time.`,
    );
  }
  return out;
}
