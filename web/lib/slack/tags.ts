// Who SearchOps can tag, by Slack member ID.
//
// ── Why IDs and not names ───────────────────────────────────────────────────────────────────────
//
// An incoming webhook cannot call users.list, so it can never turn "Waleed Idrees" into a member id
// — the broken-link digest's name-matching path resolves nothing today for exactly that reason
// (measured: 16 names tested, 0 matched).
//
// It CAN use an id it already has. `<@U0A53K76H6G>` in a payload renders as a real, clickable,
// notifying mention over a plain webhook. The limitation is lookup, not mentioning, and conflating
// the two is why this looked impossible.
//
// ── Why the ids live in code ────────────────────────────────────────────────────────────────────
//
// A member id is not a secret: it is visible to everyone in the workspace and useless outside it.
// Env-only would mean the feature silently does nothing until a variable reaches Vercel, and an
// un-pinged reviewer looks exactly like a reviewer who was pinged and ignored it. Every list below
// is overridable by env for when someone changes team.

/** The directory. One place, so a new surface never has to re-derive an id from a Slack export. */
export const PEOPLE = {
  ahmed: { id: "U0BAZTH47DW", name: "Ahmed Hassan" },
  arooj: { id: "U0A6Y397GAC", name: "Arooj Ishtiaq" },
  arsalan: { id: "U084T7ZN99Q", name: "Muhammad Arsalan" },
  waleed: { id: "U0A53K76H6G", name: "Waleed Idrees" },
  tooba: { id: "U092AB9MM5Y", name: "Tooba Siddiqui" },
  faisal: { id: "U09GEV3K815", name: "Faisal Saeed" },
  zahida: { id: "U0AG4PS4W6P", name: "Zahida Misher" },
  sabahat: { id: "U0AFP46UX5W", name: "Sabahat Malik" },
} as const;

export type PersonKey = keyof typeof PEOPLE;

/** Slack mention syntax, e.g. `<@U084T7ZN99Q> <@U0A53K76H6G>`. */
export function mentions(ids: string[]): string {
  return ids.map((id) => `<@${id}>`).join(" ");
}

/** Plain names, for a notification that should NOT ring anyone's phone. */
export function names(keys: readonly PersonKey[]): string {
  return keys.map((k) => PEOPLE[k].name).join(", ");
}

function idsFrom(envValue: string | undefined, fallback: readonly PersonKey[]): string[] {
  const raw = (envValue ?? "").trim();
  if (!raw) return fallback.map((k) => PEOPLE[k].id);
  // Accepts bare ids or already-formatted <@U…>. Whoever sets the variable should not have to know
  // which form is wanted; getting it wrong would post a literal "<@U…>" into the channel.
  const ids = raw.split(/[,\s]+/)
    .map((s) => s.trim().replace(/^<@/, "").replace(/>$/, ""))
    .filter((s) => /^[UW][A-Z0-9]{6,}$/i.test(s));
  return ids.length ? ids : fallback.map((k) => PEOPLE[k].id);
}

/**
 * Who reviews what.
 *
 * Deliberately per-surface rather than one "notify everyone" list. A frontend engineer does not need
 * pinging about an SEO blog draft, and a channel where every notification tags eight people is one
 * everybody mutes inside a week — after which the notification that mattered arrives somewhere
 * nobody reads.
 */
/**
 * ── Removed from every audience on 2026-08-21, by request ──────────────────────────────────────
 *
 *   arooj · arsalan · faisal · sabahat
 *
 * Their entries stay in PEOPLE above so the ids are still on record and adding one back is a
 * one-word change, but they are in no audience and are therefore never mentioned.
 *
 * IMPORTANT: the `env` field on each audience OVERRIDES `who` entirely (see idsFrom). Every one of
 * these four variables is set in the deployed environment, so editing this file alone changes
 * nothing in production — the variable has to be updated too. That is exactly how a removal here
 * would look done and not be.
 */
const AUDIENCES = {
  /** A blog draft written in SearchOps — the writers who read and publish it. */
  blog: { env: "SLACK_TAG_BLOG", who: ["tooba"] },
  /**
   * A blog draft from the Atlas endpoint. The writers, PLUS Ahmed, who owns that integration —
   * an externally-triggered draft can fail for reasons the writers cannot act on.
   *
   * Ahmed is here for ATLAS specifically. A draft written by SearchOps's own autopilot is not an Atlas
   * draft and must not use this audience — see the requester check in lib/blog/request.ts.
   */
  atlas: { env: "SLACK_TAG_ATLAS", who: ["ahmed", "tooba"] },
  /** A landing page draft: it needs a route hardcoded in imagine-web and the page eyeballed. */
  landing: { env: "SLACK_TAG_LANDING", who: ["waleed"] },
  /** Site health, indexing, retired URLs. */
  site: { env: "SLACK_TAG_SITE", who: ["waleed"] },
} as const satisfies Record<string, { env: string; who: readonly PersonKey[] }>;

export type Audience = keyof typeof AUDIENCES;

/**
 * The mention string for an audience, or "" when nobody is configured — so a caller can interpolate
 * it unconditionally without leaving a dangling "cc:" behind.
 */
export function tagFor(audience: Audience): string {
  const a = AUDIENCES[audience];
  const ids = idsFrom(process.env[a.env], a.who);
  return ids.length ? mentions(ids) : "";
}

/** Plain-text version of an audience, for a message that should not ping (a failed run, a test). */
export function namesFor(audience: Audience): string {
  return names(AUDIENCES[audience].who);
}

/** Everyone in the directory. For a one-off announcement, never for routine notifications. */
export function tagEveryone(): string {
  return mentions(Object.values(PEOPLE).map((p) => p.id));
}
