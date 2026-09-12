// Google Calendar: read free/busy, book a slot, attach a Meet link.
//
// Built so that everything except the credential is done. The credential is genuinely the hard part and
// it is not an API key — it is a per-mailbox OAuth grant, for a reason worth stating because it changes
// what you have to go and get:
//
//   Search Console works from a SERVICE ACCOUNT (GSC_SA_JSON) because a property can be shared with a
//   robot. A calendar cannot. Reading when Raamiz is free means acting AS Raamiz, so it needs either
//   (a) a refresh token from each sending mailbox consenting to the calendar scope, or
//   (b) a service account with domain-wide delegation, which a Workspace admin must authorise.
//
// (b) is the right answer for a team and the one to ask the admin for. Both are supported below.
//
// Scopes needed:
//   https://www.googleapis.com/auth/calendar.events    create the event
//   https://www.googleapis.com/auth/calendar.readonly  read free/busy
//
// Meet links are NOT created by a separate API. You attach a conferenceData request to the event insert
// and pass conferenceDataVersion=1 — miss that query param and the event is created silently WITHOUT a
// link, which is the failure mode to know about because nothing errors.

import { GoogleAuth, type JWT } from "google-auth-library";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export interface CalendarSlot {
  /** ISO 8601, with offset. */
  start: string;
  end: string;
}

export interface BookedMeeting {
  eventId: string;
  meetUrl: string | null;
  htmlLink: string | null;
  start: string;
  end: string;
}

function saJson(): Record<string, unknown> | null {
  // Reuses the same credential shape as GSC so a Workspace admin can grant delegation once. Falls back to
  // a calendar-specific blob when the two need different service accounts.
  const raw = process.env.CALENDAR_SA_JSON?.trim() || process.env.GSC_SA_JSON?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function calendarEnabled(): boolean {
  return !!saJson();
}

/**
 * An authorised client acting AS one mailbox.
 *
 * `subject` is the impersonation target and it is required, not optional. Without it the client acts as
 * the service account itself, which has its own empty calendar — so free/busy would come back completely
 * free and every booking would land somewhere nobody looks. That is a silent wrong answer, which is worse
 * than an error, so this throws instead of defaulting.
 */
async function clientFor(mailbox: string): Promise<JWT> {
  const creds = saJson();
  if (!creds) throw new Error("CALENDAR_SA_JSON / GSC_SA_JSON is not set.");
  if (!mailbox) throw new Error("A mailbox to act as is required — see the note on impersonation.");
  const auth = new GoogleAuth({ credentials: creds, scopes: SCOPES, clientOptions: { subject: mailbox } });
  return (await auth.getClient()) as JWT;
}

async function api<T>(mailbox: string, path: string, init: RequestInit = {}): Promise<T> {
  const client = await clientFor(mailbox);
  const token = await client.getAccessToken();
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Calendar ${path} ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/**
 * Free 30-minute slots in the next `days` working days.
 *
 * Deliberately conservative about what counts as offerable: inside working hours, on weekdays, never in
 * the next two hours. Offering a slot 20 minutes out reads as automated, and a prospect who accepts it
 * finds nobody there.
 */
export async function findFreeSlots(
  mailbox: string,
  opts: { days?: number; slotMinutes?: number; workStartHour?: number; workEndHour?: number; max?: number } = {},
): Promise<CalendarSlot[]> {
  const days = opts.days ?? 5;
  const slot = opts.slotMinutes ?? 30;
  const startHour = opts.workStartHour ?? 10;
  const endHour = opts.workEndHour ?? 17;
  const max = opts.max ?? 3;

  const now = new Date();
  const timeMin = new Date(now.getTime() + 2 * 60 * 60 * 1000); // the two-hour floor
  const timeMax = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const busy = await api<{ calendars: Record<string, { busy: Array<{ start: string; end: string }> }> }>(
    mailbox,
    "/freeBusy",
    {
      method: "POST",
      body: JSON.stringify({
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        items: [{ id: mailbox }],
      }),
    },
  );
  const blocks = (busy.calendars?.[mailbox]?.busy ?? []).map((b) => ({
    from: new Date(b.start).getTime(),
    to: new Date(b.end).getTime(),
  }));

  const out: CalendarSlot[] = [];
  const cursor = new Date(timeMin);
  cursor.setMinutes(0, 0, 0);

  while (cursor < timeMax && out.length < max) {
    const day = cursor.getDay();
    const hour = cursor.getHours();
    // Weekends and out-of-hours are skipped by advancing, not by testing every 30 minutes through the
    // night — otherwise this loops thousands of times to find three slots.
    if (day === 0 || day === 6 || hour < startHour || hour >= endHour) {
      cursor.setHours(cursor.getHours() + 1);
      continue;
    }
    const from = cursor.getTime();
    const to = from + slot * 60 * 1000;
    const overlaps = blocks.some((b) => from < b.to && to > b.from);
    if (!overlaps) out.push({ start: new Date(from).toISOString(), end: new Date(to).toISOString() });
    cursor.setMinutes(cursor.getMinutes() + slot);
  }
  return out;
}

/**
 * Book a slot and attach a Google Meet link.
 *
 * `conferenceDataVersion=1` is load-bearing: without that query parameter the event is created fine and
 * simply has no Meet link, with no error anywhere. The whole point of the call is the link, so the absence
 * would be discovered by a prospect clicking nothing.
 *
 * `sendUpdates=all` so the prospect actually receives the invite. Default is `none`, which books a meeting
 * only we know about.
 */
export async function bookMeeting(
  mailbox: string,
  input: { slot: CalendarSlot; attendeeEmail: string; attendeeName?: string | null; summary: string; description?: string },
): Promise<BookedMeeting> {
  const requestId = `summit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ev = await api<{
    id: string;
    htmlLink?: string;
    hangoutLink?: string;
    conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
    start?: { dateTime?: string };
    end?: { dateTime?: string };
  }>(mailbox, `/calendars/${encodeURIComponent(mailbox)}/events?conferenceDataVersion=1&sendUpdates=all`, {
    method: "POST",
    body: JSON.stringify({
      summary: input.summary,
      description: input.description ?? "",
      start: { dateTime: input.slot.start },
      end: { dateTime: input.slot.end },
      attendees: [{ email: input.attendeeEmail, displayName: input.attendeeName ?? undefined }],
      conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: "hangoutsMeet" } } },
    }),
  });

  const meet =
    ev.hangoutLink ??
    ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
    null;

  return {
    eventId: ev.id,
    meetUrl: meet,
    htmlLink: ev.htmlLink ?? null,
    start: ev.start?.dateTime ?? input.slot.start,
    end: ev.end?.dateTime ?? input.slot.end,
  };
}

/** "Tuesday 5 August, 10:00–10:30 (BST)" — for pasting into a reply. */
export function describeSlot(slot: CalendarSlot, timeZone?: string): string {
  const s = new Date(slot.start);
  const e = new Date(slot.end);
  const opts: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long", timeZone };
  const t: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", timeZone, timeZoneName: "short" };
  return `${s.toLocaleDateString("en-GB", opts)}, ${s.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone })}–${e.toLocaleTimeString("en-GB", t)}`;
}
