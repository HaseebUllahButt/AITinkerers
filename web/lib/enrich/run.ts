import { upsertContact, saveEnrichmentRun, markEmailSearchAttempted } from "@/lib/db/queries";
import { resolveEmailCascade } from "@/lib/enrich/cascade";
import { resolveLinkedinCascade } from "@/lib/enrich/linkedinCascade";
import type { DomainPattern } from "@/lib/enrich/patternInfer";
import { isLikelyPersonName, isRoleEmail, isPlaceholderEmail } from "@/lib/enrich/personFilter";
import {
  enrichStep, enrichResult, finishEnrich, getEnrich, doneCount,
  snapshotToRedis, checkAbort, clearEnrichTargets,
} from "@/lib/enrich/enrichBuffer";
import { qstashPublish, isServerless } from "@/lib/qstash";
import type { HunterDomainResult } from "@/lib/enrich/hunter";
import { BlitzDomainCache } from "@/lib/enrich/blitz";

const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;

export interface EnrichTarget { id: string; name: string; host: string; publication: string }
export type FindMode = "email" | "linkedin";

// Leave headroom under Vercel's 300s function limit: process until this, then hand off to a
// fresh invocation via QStash. Locally (no limit) we run the whole list in one pass.
const CHUNK_BUDGET_MS = isServerless() ? 200_000 : Infinity;

interface Caches {
  patternCache: Map<string, DomainPattern | null>;
  domainVerify: Map<string, "safe" | "catch_all" | "invalid" | "unknown">;
  // Hunter charges one search credit per domain-search CALL, and a campaign routinely has several
  // prospects at the same publication. Sharing this across the whole run turns 15 prospects over 6
  // domains into 6 credits instead of 15.
  hunterDomains: Map<string, HunterDomainResult | null>;
  // Blitz's roster step costs two lookups per DOMAIN (company, then employees). Shared for the same
  // reason as hunterDomains: several prospects at one publication should pay for it once.
  blitzCache: BlitzDomainCache;
}

async function processOne(a: EnrichTarget, mode: FindMode, caches: Caches): Promise<void> {
  const onStep = (detail: string) => enrichStep(a.name, detail, a.publication, a.id);

  if (!isLikelyPersonName(a.name, a.publication)) {
    // Mark it attempted even though nothing was searched. Without this, a pseudo-author
    // ("<Publication> Editorial", "Unknown", "Team") never leaves the "needs email" queue — the
    // NEXT onlyNew run selects it again, forever, since there is no name here that will ever
    // resolve to a person's inbox no matter how many times it's retried.
    //
    // Found live: 91 authors sat in this exact state and had been re-run three times over two days
    // (4 Aug, 5 Aug 08:00, 5 Aug 10:23), reporting found:0 every time — 80 were literally named
    // "<X> Editorial", the rest "Unknown"/"Team"/"No Author"/a bare publisher name. No API credits
    // were being wasted (the reject happens before any network call), but the backlog count was
    // permanently overstated by exactly this many, making "authors needing email" look bigger and
    // more promising than the real, findable remainder actually is.
    await markEmailSearchAttempted(a.id).catch(() => {});
    enrichResult({ name: a.name, authorId: a.id, publication: a.publication, found: false });
    return;
  }

  // ── LinkedIn-only mode ──────────────────────────────────────────────
  if (mode === "linkedin") {
    const issues: string[] = [];
    const li = await resolveLinkedinCascade(a, { onStep, onIssue: (m) => issues.push(m) });
    if (li) {
      await upsertContact({ author_id: a.id, type: "linkedin", value: li.url, confidence: 0.85, source: `linkedin-${li.source}`, verified_syntax: true }).catch(() => {});
      enrichResult({ name: a.name, authorId: a.id, publication: a.publication, found: true, email: li.url, source: `linkedin-${li.source}` });
    } else {
      enrichResult({ name: a.name, authorId: a.id, publication: a.publication, found: false, issues });
    }
    return;
  }

  // ── Email mode (full cascade) ────────────────────────────────────────
  const issues: string[] = [];
  let discoveredLinkedin: string | null = null;
  // Every non-email contact the cascade saw. Persisted whatever the email outcome, because a prospect
  // reachable on X or through a contact form is a manual prospect, not a dead one.
  const foundContacts: Array<{ type: string; value: string; confidence: number }> = [];
  let r = await resolveEmailCascade(a, {
    onStep,
    onIssue: (m) => issues.push(m),
    onLinkedin: (url) => { discoveredLinkedin = url; },
    onContact: (c) => { foundContacts.push(c); },
    patternCache: caches.patternCache,
    domainVerify: caches.domainVerify,
    hunterDomains: caches.hunterDomains,
    blitzCache: caches.blitzCache,
  });

  if (discoveredLinkedin) {
    onStep(`saved LinkedIn: ${(discoveredLinkedin as string).replace("https://", "")}`);
    await upsertContact({ author_id: a.id, type: "linkedin", value: discoveredLinkedin, confidence: 0.85, source: "linkedin-cascade", verified_syntax: true }).catch(() => {});
  }

  if (r) {
    const e = r.email.toLowerCase().trim();
    // The final gate before storage: whatever cascade step produced this, a placeholder must never
    // be written as a contact. It would be stored at "sourced" trust and cleared to send.
    if (!EMAIL_RE.test(e) || isRoleEmail(e) || isPlaceholderEmail(e)) r = null;
    else r = { ...r, email: e };
  }

  // Mark attempted regardless of outcome — this is what lets a future run target only
  // authors who've truly never been searched, instead of re-trying known failures.
  await markEmailSearchAttempted(a.id).catch(() => {});

  // Store every alternative channel first. Ordered before the email write so a failure there cannot
  // discard the fallbacks, which are exactly what is left when the email is missing.
  for (const c of foundContacts) {
    await upsertContact({
      author_id: a.id, type: c.type as never, value: c.value,
      confidence: c.confidence, source: "cascade-signal", verified_syntax: true,
    }).catch(() => {});
  }
  if (foundContacts.length && !r) {
    enrichStep(a.name, `no email, but kept ${foundContacts.length} other contact route${foundContacts.length === 1 ? "" : "s"}: ${foundContacts.map((c) => c.type).join(", ")}`, a.publication, a.id);
  }

  if (r) {
    await upsertContact({
      author_id: a.id, type: "mailto", value: `mailto:${r.email}`,
      confidence: r.score ? r.score / 100 : 0.8, source: r.source, verified_syntax: true,
      // Only set for a Hunter alt contact. Null keeps the pitch greeting the author, as before.
      owner_name: r.ownerName ?? null, owner_position: r.ownerPosition ?? null,
    }).catch(() => {});
    enrichResult({ name: a.name, authorId: a.id, publication: a.publication, found: true, email: r.email, source: r.source, issues });
  } else {
    enrichResult({ name: a.name, authorId: a.id, publication: a.publication, found: false, issues });
  }
}

// Process targets[startIndex..] until the chunk budget, streaming per-step progress to the
// buffer (mirrored to Redis) and persisting each result to the DB as it goes. On Vercel, if
// the budget is hit with work remaining, it hands the rest to a fresh invocation via QStash
// (resuming at doneCount) so a run of any size completes across serverless functions.
export async function enrichLoop(
  targets: EnrichTarget[],
  mode: FindMode = "email",
  campaignId?: string,
  startIndex = 0,
): Promise<void> {
  const caches: Caches = {
    patternCache: new Map(), domainVerify: new Map(), hunterDomains: new Map(),
    blitzCache: new BlitzDomainCache(),
  };
  const startedAt = Date.now();
  const snap = setInterval(() => { void snapshotToRedis(); }, 2500);

  try {
    let i = startIndex;
    for (; i < targets.length; i++) {
      if (await checkAbort()) break;

      // Out of time on this invocation — hand off the remainder and stop WITHOUT finishing.
      if (Date.now() - startedAt > CHUNK_BUDGET_MS) {
        await snapshotToRedis();
        const handed = await qstashPublish("/api/enrich/run", { continue: true, campaign_id: campaignId, mode });
        if (handed) { clearInterval(snap); return; } // next chunk resumes at doneCount()
        break; // no QStash — stop here (partial); a manual re-run continues
      }

      try { await processOne(targets[i], mode, caches); }
      catch { enrichResult({ name: targets[i].name, authorId: targets[i].id, publication: targets[i].publication, found: false }); }
    }
  } finally {
    clearInterval(snap);
  }

  // Reached the end (or aborted / no-QStash): finalize.
  finishEnrich();
  await snapshotToRedis();
  const run = getEnrich();
  if (run) {
    await saveEnrichmentRun({
      key: run.key, campaignName: run.campaignName, total: run.total, done: run.done,
      found: run.found, bySource: run.bySource, people: run.people, startedAt: run.startedAt,
    }).catch(() => {});
  }
  await clearEnrichTargets();
}

// Re-exported so callers can resume at the right spot on a continuation chunk.
export { doneCount };
