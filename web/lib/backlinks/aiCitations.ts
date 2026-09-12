// Which pages do the AI answers cite for our keywords — asked of the engines that will actually
// tell us.
//
// This is the working half of "find backlink opportunities from AI Overviews". The other half,
// reading Google's AI Overview panel itself, is attempted on every SERP call in ./serpSurfaces.ts
// and comes back empty in practice: Serper's /search response on our key carries no `aiOverview`
// field at all (verified live 2026-09-02 across commercial and question-shaped queries — the
// response keys are searchParameters / organic / peopleAlsoAsk / relatedSearches / credits), and
// its People Also Ask entries carry only `question`, with no source link. There is no documented
// Serper endpoint that serves the panel either. So the panel's citation list is not obtainable
// with the providers we have, and code that pretended otherwise would just report zero forever.
//
// What IS obtainable, today, with keys already in the project:
//   • Gemini with google_search grounding — Google's own index, real cited sources in
//     groundingMetadata. Free tier. Verified live: 8 grounded sources for "best AI video
//     generators". This is the closest thing to an AI Overview citation list we can actually read,
//     because AI Overviews and AI Mode read the same index Googlebot builds (see ../geo/bots.ts).
//   • Perplexity (Sonar via OpenRouter) — inline citations.
//   • ChatGPT search-preview — url_citation annotations.
//
// Called an "AI answer citation" rather than an AI Overview citation on purpose. It is a different
// surface with a strongly overlapping source set, and labelling it as Google's panel would be a
// claim we cannot support.
//
// The engine adapters are ./geo.ts's, not copies: the GEO agent already normalises each API's
// citation shape, and two copies would drift the first time one of them changed.
import PQueue from "p-queue";

import { resolveEngines } from "./answerEngines";
import type { GeoEngineId } from "./answerEngines";

export interface AiCitation {
  /** Cited page URL. Gemini gives a domain (its uri is a Google redirect), so this is often a root. */
  url: string;
  domain: string;
  /** Which engine cited it, by label ("Gemini", "Perplexity"). */
  engine: string;
  /** The prompt it was cited for — real question language, useful in the pitch. */
  prompt: string;
  /** Was our own brand mentioned in the answer that cited it? */
  brandMentioned: boolean;
}

export interface AiCitationResult {
  citations: AiCitation[];
  /** Engines that answered at least one prompt. */
  enginesUsed: string[];
  /** Engines that could not be asked, with the reason — never silently omitted. */
  unavailable: Array<{ engine: string; reason: string }>;
  prompts: number;
  answered: number;
  notes: string[];
}

function domainOf(url: string): string | null {
  try { return new URL(url).host.replace(/^www\./, "").toLowerCase(); } catch { return null; }
}

/**
 * Ask every configured answer engine the given prompts and collect who they cite.
 *
 * `exclude` drops hosts that are never editorial link targets plus our own domain — the caller
 * owns that vocabulary, so it is passed in rather than duplicated here.
 */
export async function aiAnswerCitations(
  prompts: string[],
  opts: {
    brandAliases?: string[];
    exclude?: (domain: string) => boolean;
    engines?: GeoEngineId[];
    perplexityModel?: string;
    concurrency?: number;
    /** Absolute epoch-ms deadline. Asks not started by then are skipped and reported, so this
     *  phase cannot eat a serverless function's whole budget when an engine is slow. */
    deadline?: number;
  } = {},
): Promise<AiCitationResult> {
  const notes: string[] = [];
  // google_aio is deliberately NOT asked here: it is the Serper SERP call, which the discovery run
  // already makes for every query, so asking again would spend credits to learn the same thing.
  const wanted = opts.engines ?? (["gemini", "perplexity", "chatgpt"] as GeoEngineId[]);
  const defs = resolveEngines(opts.perplexityModel ?? "perplexity/sonar", wanted);
  const active = defs.filter((e) => e.available);
  const unavailable = defs.filter((e) => !e.available).map((e) => ({ engine: e.label, reason: e.reason ?? "not configured" }));

  if (!active.length) {
    notes.push(
      "No AI answer engine is configured, so no AI-answer citations were read " +
      `(${unavailable.map((u) => `${u.engine}: ${u.reason}`).join("; ") || "none available"}).`,
    );
    return { citations: [], enginesUsed: [], unavailable, prompts: prompts.length, answered: 0, notes };
  }

  const aliases = (opts.brandAliases ?? []).map((a) => a.toLowerCase());
  const citations: AiCitation[] = [];
  const enginesUsed = new Set<string>();
  let answered = 0;

  const queue = new PQueue({ concurrency: opts.concurrency ?? 3 });
  let skippedForTime = 0;
  let retried = 0;
  await Promise.all(
    prompts.flatMap((prompt) =>
      active.map((eng) =>
        queue.add(async () => {
          if (opts.deadline && Date.now() > opts.deadline) { skippedForTime++; return; }
          // One retry, because the common failure here is transient upstream load rather than a
          // dead key — Gemini answered a prompt and then returned 503 "experiencing high demand"
          // for the next one, minutes apart, on the same key. Without the retry that whole engine
          // reads as unavailable for the run and the best prospects are simply never found.
          let res = await eng.ask(prompt).catch(() => null);
          if (!res && (!opts.deadline || Date.now() + 3_000 < opts.deadline)) {
            retried++;
            await new Promise((r) => setTimeout(r, 1_500));
            res = await eng.ask(prompt).catch(() => null);
          }
          if (!res) return;
          answered++;
          enginesUsed.add(eng.label);
          const brandMentioned = aliases.some((a) => res.content.toLowerCase().includes(a));
          for (const raw of res.citations) {
            const domain = domainOf(raw);
            if (!domain) continue;
            if (opts.exclude?.(domain)) continue;
            citations.push({ url: raw, domain, engine: eng.label, prompt, brandMentioned });
          }
        }),
      ),
    ),
  );

  if (unavailable.length) {
    notes.push(`Not asked: ${unavailable.map((u) => `${u.engine} (${u.reason})`).join("; ")}.`);
  }
  if (skippedForTime) {
    notes.push(`${skippedForTime} engine prompt${skippedForTime === 1 ? "" : "s"} were skipped for time this run — press again to cover them.`);
  }
  if (answered === 0) {
    notes.push(
      `${active.map((e) => e.label).join(", ")} answered none of the ${prompts.length} prompts` +
      `${retried ? ` (each retried once)` : ""} — out of credits, rate-limited, or temporarily overloaded. ` +
      "That is an outage, not an absence of citations: press again in a minute.",
    );
  } else if (!citations.length) {
    notes.push(`${[...enginesUsed].join(", ")} answered but cited no linkable sources (their answers carried no usable citations).`);
  }

  return { citations, enginesUsed: [...enginesUsed], unavailable, prompts: prompts.length, answered, notes };
}
