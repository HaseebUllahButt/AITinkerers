import type { EmailSendConfig } from "@/lib/types";

export interface ScheduleRecipient {
  id: string;   // email id
  tz: string;   // recipient's inferred IANA timezone
}

export interface ScheduledSlot {
  id: string;
  at: string;   // UTC ISO
}

// ── Wall-clock helpers (interpret/produce times in a given IANA timezone) ──────
interface WC { y: number; m: number; d: number; h: number; min: number }

function partsInTz(ms: number, tz: string): WC {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(ms).map((x) => [x.type, x.value])) as any;
  let h = parseInt(p.hour, 10);
  if (h === 24) h = 0;
  return { y: +p.year, m: +p.month, d: +p.day, h, min: +p.minute };
}

// Convert a wall-clock time in `tz` to a UTC epoch-ms instant.
function utcFromLocal(wc: WC, tz: string): number {
  const guess = Date.UTC(wc.y, wc.m - 1, wc.d, wc.h, wc.min, 0);
  const seen = partsInTz(guess, tz);
  const seenMs = Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.min, 0);
  const offset = seenMs - guess; // how far tz is from UTC at this instant
  return guess - offset;
}

function localHour(ms: number, tz: string): number {
  return partsInTz(ms, tz).h;
}

/** Local calendar day as a comparable key, for counting sends per day in the sender's timezone. */
function localDayKey(ms: number, tz: string): string {
  const p = partsInTz(ms, tz);
  return `${p.y}-${p.m}-${p.d}`;
}

// Local window start (startH:00) on the same local day as `ms`.
function windowStartSameDay(ms: number, tz: string, startH: number): number {
  const p = partsInTz(ms, tz);
  return utcFromLocal({ ...p, h: startH, min: 0 }, tz);
}

// Local window start on the day AFTER the local day of `ms`.
function windowStartNextDay(ms: number, tz: string, startH: number): number {
  const p = partsInTz(ms, tz);
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d));
  next.setUTCDate(next.getUTCDate() + 1);
  return utcFromLocal({ y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate(), h: startH, min: 0 }, tz);
}

// Earliest acceptable send instant for a recipient: now if inside their window,
// else today's window start (if before) or tomorrow's (if after).
function earliestFor(nowMs: number, tz: string, startH: number, endH: number): number {
  const h = localHour(nowMs, tz);
  if (h < startH) return windowStartSameDay(nowMs, tz, startH);
  if (h >= endH) return windowStartNextDay(nowMs, tz, startH);
  return nowMs;
}

function clampHour(h: number | undefined, dflt: number): number {
  if (h == null || isNaN(h)) return dflt;
  return Math.min(23, Math.max(0, Math.floor(h)));
}

/** The stored `gap_minutes` is the MINIMUM gap; the actual gap is random in [gap, 2×gap].
 *  15 therefore means "15 to 30 minutes apart", which is the policy the team set and expects.
 *  The jitter is not decoration: a mailbox emitting one message exactly every 15:00 minutes is
 *  itself a machine signature, and the point of spacing is to not look like a machine. */
function gapRange(config: PacingConfig): { minMs: number; maxMs: number } {
  const raw = Number(config.gap_minutes);
  const min = Number.isFinite(raw) && raw > 0 ? Math.min(240, Math.floor(raw)) : 15;
  return { minMs: min * 60_000, maxMs: min * 2 * 60_000 };
}

/** The four fields that decide pacing. Narrower than EmailSendConfig on purpose: the Settings
 *  card holds a UserEmailConfig, not a workflow config, and both should be able to ask "how many
 *  a day does this allow?" without inventing the fields they don't have. */
export type PacingConfig = Pick<EmailSendConfig, "send_hour_start" | "send_hour_end" | "gap_minutes" | "daily_cap">;

export interface ScheduleOptions {
  /** Injectable RNG so the spacing can be asserted in a test. Defaults to Math.random. */
  rand?: () => number;
}

/**
 * Spaced schedule: one send every [gap, 2×gap] minutes inside the sender's local window,
 * spilling into the following day's window when today's is exhausted.
 *
 * ── Why this is not a burst ─────────────────────────────────────────────────────
 *
 * This used to stamp every email in a batch with ONE instant and let the drain send the lot
 * ("burst model", 29 Jul 2026). Measured consequence, 2 Sep 2026: 23 initials from one Gmail all
 * carried scheduled_at 13:33:32Z and left the mailbox inside 46 seconds. Twenty-three cold emails
 * from one address in under a minute is the exact pattern spam filters are built to catch, and it
 * is what the outreach team reported.
 *
 * The settings were never changed to match that model — every account in user_email_config still
 * has gap_minutes 15 and daily_cap 40-50 — so the tool was storing a pacing policy, showing it to
 * the team, and then ignoring it. `gap_minutes` and `daily_cap` are honoured again here.
 *
 * ── The arithmetic, stated because it constrains the team ──────────────────────
 *
 * A 09:00-17:00 window is 480 minutes, so at 15-30 minute gaps one account fits ~21 sends a day
 * (32 at the 15-minute floor). A queue larger than that rolls into the next day's window, and the
 * one after, for as long as it takes. That is deliberate: the alternative to a slow queue is a
 * burned sending domain. Widen the window or add a sending account for more throughput.
 *
 * `daily_cap` still applies on top, for a sender who wants a lower ceiling than the window allows.
 *
 * ── One timezone per batch ─────────────────────────────────────────────────────
 *
 * Pacing is computed in the SENDER's timezone, not each recipient's: the whole queue leaves one
 * mailbox, and it is that mailbox's emission pattern that a spam filter scores. `ScheduleRecipient.tz`
 * is therefore carried but unused — it was unused under the burst model too, and per-recipient
 * windows cannot be paced against a shared account without either breaking the gap or the window.
 */
export function computeSmartSchedule(
  recipients: ScheduleRecipient[],
  config: EmailSendConfig,
  now: Date,
  opts: ScheduleOptions = {},
): ScheduledSlot[] {
  const startH = clampHour(config.send_hour_start, 9);
  const endH = Math.max(startH + 1, clampHour(config.send_hour_end, 17));
  const tz = config.timezone;
  const { minMs, maxMs } = gapRange(config);
  const rand = opts.rand ?? Math.random;
  const capRaw = Number(config.daily_cap);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : Infinity;

  let cursor = earliestFor(now.getTime(), tz, startH, endH);
  let dayKey = localDayKey(cursor, tz);
  let sentThisDay = 0;
  const out: ScheduledSlot[] = [];

  for (const r of recipients) {
    // Pull the cursor into a send window: a gap that ran past today's close (or over midnight)
    // lands on the next open. This is the same rule that picks the batch's first slot, applied
    // to every slot, which is what makes the spill-into-tomorrow behaviour fall out for free.
    cursor = earliestFor(cursor, tz, startH, endH);
    const day = localDayKey(cursor, tz);
    if (day !== dayKey) { dayKey = day; sentThisDay = 0; }
    // The sender's own ceiling, on top of whatever the window would allow.
    if (sentThisDay >= cap) {
      cursor = windowStartNextDay(cursor, tz, startH);
      dayKey = localDayKey(cursor, tz);
      sentThisDay = 0;
    }

    out.push({ id: r.id, at: new Date(cursor).toISOString() });
    sentThisDay++;
    cursor += minMs + Math.floor(rand() * (maxMs - minMs + 1));
  }

  return out;
}

/**
 * How many sends one config fits in a single day's window — the number the UI quotes so nobody
 * has to work out why a 100-email queue is going to take a week.
 */
export function dailyCapacity(config: PacingConfig): number {
  const startH = clampHour(config.send_hour_start, 9);
  const endH = Math.max(startH + 1, clampHour(config.send_hour_end, 17));
  const { minMs, maxMs } = gapRange(config);
  const windowMs = (endH - startH) * 3_600_000;
  const avgGap = (minMs + maxMs) / 2;
  const byWindow = Math.max(1, Math.floor(windowMs / avgGap) + 1);
  const capRaw = Number(config.daily_cap);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : Infinity;
  return Math.min(byWindow, cap);
}
