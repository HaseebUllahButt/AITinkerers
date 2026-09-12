// Who or what made a draft, in one place.
//
// ── The bug this module exists to close ─────────────────────────────────────────────────────────
//
// ensureThumbnails.ts is gated on "machine-written", tested as `/^api:/` against created_by, and its
// own header comment says it covers a draft that "arrived from Atlas or was written by Summer". The
// second half was never true: Summer stamped `ctx.userEmail`, so every draft it wrote was
// indistinguishable from one somebody typed by hand, and the sweep skipped all of them. Measured on
// draft a21111ed ("Grok 4.6", created_by raamiz.niazi@imagine.art) — written by Summer, never
// thumbnailed, and a missing thumbnail is a hard publish blocker.
//
// The gate itself was right. What was missing was any way for Summer's writes to say so.
//
// ── Why the human's address is kept ─────────────────────────────────────────────────────────────
//
// `api:summer` alone would lose who asked, and that matters: a draft is reviewed by the person who
// commissioned it, and Slack's ready-notification names the writer. So the actor is
// `api:summer:<email>` — machine-made for the sweeps, attributable for the humans. Nothing filters
// blog drafts by created_by equality (checked), so widening the format is safe; the four places that
// display it all strip the prefix, and they now do it through labelFor rather than four regexes.
//
// Client-safe LEAF: no imports. DraftsShell renders the badge in the browser.

/** Machine actors this app writes as. Atlas arrives over the API with its own `api:atlas*` values. */
const SUMMER = "api:summer";
const WRITER = "api:writer";

/**
 * `api:<machine>:<person>` — machine-made for the sweeps, attributable for the humans.
 *
 * Deliberately keeps `api:` FIRST so every existing machine-made test keeps working unchanged: the
 * point of this format is that ensureThumbnails needed no new case to start including these.
 */
function actor(machine: string, email: string | null | undefined): string {
  const who = (email ?? "").trim();
  return who ? `${machine}:${who}` : machine;
}

/** For a draft Summer writes on somebody's behalf. */
export function summerActor(email: string | null | undefined): string {
  return actor(SUMMER, email);
}

/**
 * For a draft the AI writer produces from an approved cluster plan.
 *
 * The email here is who APPROVED the plan, not who typed the article — nobody typed it. Same
 * reasoning as Summer: an approver is not standing over the draft, so its missing thumbnail is a job
 * nobody is going to do. clusterRun.ts stamped the bare approver address and so its drafts were
 * skipped by the very sweep whose comment claims to cover "a Summer/writer session".
 */
export function writerActor(email: string | null | undefined): string {
  return actor(WRITER, email);
}

/** Written by a machine — the API, Atlas, or a Summer session. Never a hand-made draft. */
export function isMachineMade(createdBy: string | null | undefined): boolean {
  return /^api:/i.test(String(createdBy ?? ""));
}

/** Did Summer write this one? */
export function isSummerMade(createdBy: string | null | undefined): boolean {
  return /^api:summer\b/i.test(String(createdBy ?? ""));
}

/** The person a machine acted for, when there is one. Null for Atlas, the API, and hand-made drafts. */
export function actedFor(createdBy: string | null | undefined): string | null {
  const m = /^api:(?:summer|writer):(.+)$/i.exec(String(createdBy ?? "").trim());
  return m ? m[1].trim() || null : null;
}

/**
 * A short, scannable origin label — what a badge shows and a sentence names.
 *
 * `api:summer:raamiz.niazi@imagine.art` → "summer", not "summer:raamiz.niazi@imagine.art". The raw
 * value stays searchable wherever search reads created_by directly, so nothing is lost by shortening
 * the label; a badge is a glance, not a record.
 */
export function labelFor(createdBy: string | null | undefined): string | null {
  const who = String(createdBy ?? "").trim();
  if (!who) return null;
  if (/^api:atlas/i.test(who)) return "atlas";
  if (isSummerMade(who)) return "summer";
  if (/^api:writer\b/i.test(who)) return "writer";
  if (/^api:/i.test(who)) return who.replace(/^api:/i, "").trim() || "api";
  // A person: their local part is enough to scan a list by.
  return who.split("@")[0];
}

/**
 * A full-sentence attribution, for a Slack line or a notification detail.
 *
 * Names the machine AND the person, because "Written by: summer" leaves a reviewer wondering whose
 * draft it is, and that is the one thing they need in order to go and ask about it.
 */
export function attributionFor(createdBy: string | null | undefined): string | null {
  const who = String(createdBy ?? "").trim();
  if (!who) return null;
  const forWhom = actedFor(who);
  if (forWhom) return `${isSummerMade(who) ? "Summer" : "the writer"}, for ${forWhom}`;
  if (/^api:atlas/i.test(who)) return "Atlas";
  if (/^api:/i.test(who)) return who.replace(/^api:/i, "").trim() || "the API";
  return who;
}
