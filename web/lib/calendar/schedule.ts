// When a prospect asks for a call, offer real times — or book one — instead of parking the thread.
//
// The negotiator already detects this. classifyReplyIntent() returns intervention types `scheduling`
// ("share your availability" / "send a calendar link") and `sync_contact` ("can we jump on a call"), and
// today both do the same thing: stop, flag for a human, wait. That is the correct default for something
// an email-only agent cannot do — but scheduling IS something it can do once it can see a calendar, and
// it is the single most time-sensitive intervention in the funnel. A prospect who asks for a call has
// self-identified as interested; a two-day wait for someone to notice the flag is where those die.
//
// Deliberately NOT fully autonomous in both cases:
//
//   scheduling   → offer concrete times in a reply. Low risk: naming three free slots commits nothing,
//                  and it moves the thread without a person.
//   sync_contact → offer times too, but never auto-book. Booking puts a meeting on a colleague's calendar
//                  with an outsider on it, which they did not agree to. The prospect picks a slot, and the
//                  booking happens when a person (or their acceptance) confirms.
//
// So the default is "propose", and booking is an explicit call. That mirrors the rest of this system: the
// agent drafts, a human sends.

import { calendarEnabled, findFreeSlots, bookMeeting, describeSlot, type CalendarSlot } from "./google";

export interface SchedulingOffer {
  /** Whether anything could be offered at all. False means the caller should fall back to parking. */
  ok: boolean;
  slots: CalendarSlot[];
  /** Ready-to-send prose naming the times. Empty when ok is false. */
  reply: string;
  reason?: string;
}

/** Intervention types this module can act on. Anything else stays a human's job. */
export const SCHEDULING_INTERVENTIONS = new Set(["scheduling", "sync_contact"]);

export function isSchedulingIntervention(type?: string | null): boolean {
  return !!type && SCHEDULING_INTERVENTIONS.has(type);
}

/**
 * Build an offer of real times from the sender's own calendar.
 *
 * The mailbox is whoever has been emailing them, not a shared account: the prospect expects the call to be
 * with the person they have been talking to, and it is that person's calendar that has to be free.
 */
export async function buildSchedulingOffer(input: {
  mailbox: string;
  prospectName?: string | null;
  timeZone?: string;
}): Promise<SchedulingOffer> {
  if (!calendarEnabled()) {
    return { ok: false, slots: [], reply: "", reason: "No calendar credential configured." };
  }
  let slots: CalendarSlot[];
  try {
    slots = await findFreeSlots(input.mailbox, { max: 3 });
  } catch (e) {
    // A calendar failure must never break reply handling — the thread falls back to a human flag, which is
    // exactly what happened before this module existed.
    return { ok: false, slots: [], reply: "", reason: e instanceof Error ? e.message : "calendar lookup failed" };
  }
  if (!slots.length) {
    return { ok: false, slots: [], reply: "", reason: "No free slots in the next five working days." };
  }

  const lines = slots.map((s) => `  · ${describeSlot(s, input.timeZone)}`);
  const reply = [
    "Happy to jump on a call. Any of these work on my side:",
    "",
    ...lines,
    "",
    "Reply with whichever suits and I will send a Google Meet invite. If none of those work, tell me a couple of times that do.",
  ].join("\n");

  return { ok: true, slots, reply };
}

/**
 * Book a slot the prospect chose and return the Meet link.
 *
 * Separate from buildSchedulingOffer on purpose — see the module note. Offering times commits nothing;
 * booking puts an outsider on a colleague's calendar, so it happens only when someone has actually picked
 * a time, never speculatively off an "interested" signal.
 */
export async function confirmMeeting(input: {
  mailbox: string;
  slot: CalendarSlot;
  attendeeEmail: string;
  attendeeName?: string | null;
  topic?: string | null;
}): Promise<{ ok: true; meetUrl: string | null; reply: string; eventId: string } | { ok: false; reason: string }> {
  if (!calendarEnabled()) return { ok: false, reason: "No calendar credential configured." };
  try {
    const booked = await bookMeeting(input.mailbox, {
      slot: input.slot,
      attendeeEmail: input.attendeeEmail,
      attendeeName: input.attendeeName ?? null,
      summary: input.topic?.trim() || `ImagineArt — ${input.attendeeName ?? "collaboration"}`,
      description: "Discussing a paid collaboration. Booked from Summit.",
    });
    const reply = [
      `Booked for ${describeSlot({ start: booked.start, end: booked.end })}.`,
      booked.meetUrl ? `\nGoogle Meet: ${booked.meetUrl}` : "\nThe calendar invite is on its way.",
      "\nSee you then.",
    ].join("");
    return { ok: true, meetUrl: booked.meetUrl, reply, eventId: booked.eventId };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "booking failed" };
  }
}

/**
 * Which slot did they pick?
 *
 * Matched against the slots WE offered rather than parsed freely from their prose. Free-text date parsing
 * on "how about Thursday?" is ambiguous — whose Thursday, what time, which week — and a wrong booking is
 * worse than asking. If nothing matches, the caller falls back to a human, who can read the sentence.
 */
export function matchOfferedSlot(replyText: string, offered: CalendarSlot[], timeZone?: string): CalendarSlot | null {
  const text = replyText.toLowerCase();

  // Parts are read in the SAME timezone the offer was rendered in. The first version used
  // Date.getDay()/getHours(), which are LOCAL — so a slot stored as 10:00Z was matched against 11 in BST
  // and "Tuesday at 10 works for me" failed, even though 10:00 is exactly what we had written to them.
  // The matcher has to agree with describeSlot or it rejects the prospect's own words back at them.
  const parts = (d: Date) => {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      weekday: "long", day: "numeric", hour: "numeric", hour12: false, timeZone,
    });
    const got: Record<string, string> = {};
    for (const p of fmt.formatToParts(d)) if (p.type !== "literal") got[p.type] = p.value;
    return { weekday: (got.weekday ?? "").toLowerCase(), day: got.day ?? "", hour: Number(got.hour ?? "0") };
  };

  for (const slot of offered) {
    const { weekday, day, hour } = parts(new Date(slot.start));
    if (!text.includes(weekday)) continue;

    // The hour in every form someone actually writes: 24-hour, zero-padded, 12-hour, and with am/pm.
    const h12 = hour % 12 || 12;
    const hourForms = [
      `${hour}`, `${String(hour).padStart(2, "0")}`, `${hour}:00`, `${String(hour).padStart(2, "0")}:00`,
      `${h12}`, `${h12}:00`, `${h12}am`, `${h12}pm`, `${h12} am`, `${h12} pm`,
    ];
    // A bare weekday is not enough — "Thursday would be better" is a counter-proposal, not a pick — so it
    // needs the date or the hour too.
    if (text.includes(day) || hourForms.some((f) => text.includes(f))) return slot;
  }
  return null;
}

