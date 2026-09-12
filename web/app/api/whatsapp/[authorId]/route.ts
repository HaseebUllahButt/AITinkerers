import { NextRequest, NextResponse } from "next/server";
import {
  getWhatsappThread, getWhatsappVendor, insertWhatsappThreadMessages, deleteWhatsappThreadMessage,
  markInboxSeen, getWaAnchor, clearWaSuggestionForAuthor, getTeamMembers, setWhatsappVendorOwner,
  renameWhatsappVendor,
} from "@/lib/db/queries";
import { supabaseAdmin } from "@/lib/db/supabase";
import { waLink, normalizeWaNumber } from "@/lib/email/whatsappNote";
import {
  parseWaExport, matchVendorSender, identifyVendorSenderLLM, splitPastedChat, draftWhatsappReply,
  addressableName,
} from "@/lib/email/whatsappThread";
import { waCloudEnabled, serviceWindowOpen, sendWaText } from "@/lib/whatsapp/cloudApi";
import { waBridgeSendEnabled, sendViaBridge, waBridgeEnabled } from "@/lib/whatsapp/bridge";
import { isPitchLang, isPitchTone } from "@/lib/email/pitchTones";
import { identifyCaller, actorFor } from "@/lib/auth/service";

// The paste splitter and the reply drafter both run a frontier model that thinks first.
export const maxDuration = 120;

// GET /api/whatsapp/[authorId] — the whole vendor conversation, plus who it's with and where the
// deal stands (the anchor). Team-visible (see getWhatsappVendorList); opening it clears this
// viewer's unread the same way the email inbox does, through the same author-keyed inbox_state.
export async function GET(req: NextRequest, { params }: { params: Promise<{ authorId: string }> }) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { authorId } = await params;
  try {
    const vendor = await getWhatsappVendor(authorId);
    if (!vendor) return NextResponse.json({ error: "No such vendor." }, { status: 404 });
    if (caller.kind === "user") await markInboxSeen(caller.email, authorId).catch(() => {});
    const [messages, anchor] = await Promise.all([getWhatsappThread(authorId), getWaAnchor(authorId)]);
    // How a send will actually leave, so the composer can say so honestly. "cloud"/"bridge" =
    // Summit sends it; "manual" = wa.me keypress (no transport, or bridge in read-only mode).
    const sendMode = waCloudEnabled() ? "cloud" : waBridgeSendEnabled() ? "bridge" : "manual";
    // Bridge configured to read but not cleared to send: the negotiator drafts suggestions, the
    // human sends. The UI uses this to frame the suggestion panel.
    const bridgeReadOnly = waBridgeEnabled() && !waBridgeSendEnabled() && !waCloudEnabled();
    return NextResponse.json({ vendor, messages, anchor, apiConfigured: waCloudEnabled(), sendMode, bridgeReadOnly });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST /api/whatsapp/[authorId] — everything that adds to (or proposes for) the thread, split by
// `kind`. Sending stays HUMAN in Phase 1 (docs/WHATSAPP_CHANNEL_PLAN.md): `send` records the
// message and hands back the wa.me deep link with it pre-typed; the person presses send in
// WhatsApp itself, exactly the 082 trust model, per message instead of per note.
//
//   { kind: "send",  body }                         → log outbound now + wa.me link back
//   { kind: "log",   direction, body, at? }         → file one message verbatim (no LLM)
//   { kind: "paste", text }                         → chat export or freeform paste → many rows
//   { kind: "draft", instruction?, lang?, tone? }   → PROPOSAL only, writes nothing
//   { kind: "assign", email }                       → whose chat this is (094); null releases it
//   { kind: "rename", name }                        → what they're actually called (095)
export async function POST(req: NextRequest, { params }: { params: Promise<{ authorId: string }> }) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { authorId } = await params;
  try {
    const vendor = await getWhatsappVendor(authorId);
    if (!vendor) return NextResponse.json({ error: "No such vendor." }, { status: 404 });
    const body = await req.json();

    // { kind: "assign", email }  → hand this chat to a colleague (email: null releases it)
    //
    // Refuses an address that is not on the roster. Ownership drives which list a chat appears in,
    // so a typo would file a live vendor under a person who does not exist and quietly remove it
    // from everyone's default view — the one failure this feature must not have.
    if (body.kind === "assign") {
      const raw = body.email;
      if (raw !== null && typeof raw !== "string") {
        return NextResponse.json({ error: "email must be a team member's address, or null to unassign" }, { status: 400 });
      }
      const email = raw ? raw.trim().toLowerCase() : null;
      if (email) {
        const roster = await getTeamMembers();
        const me = caller.kind === "user" ? caller.email.toLowerCase() : null;
        const known = roster.some((m) => m.email.toLowerCase() === email) || email === me;
        if (!known) return NextResponse.json({ error: `${email} isn't on the team, so this chat wasn't assigned.` }, { status: 400 });
      }
      await setWhatsappVendorOwner(authorId, email, actorFor(caller));
      return NextResponse.json({ ok: true, assigned_to: email });
    }

    // { kind: "rename", name }  → the name the team knows this vendor by, vouched by the caller.
    //
    // Sending the SAME name back is the "yes, that's really them" action, and it matters as much
    // as a correction: until someone says so, the negotiator treats the stored name as WhatsApp's
    // pushname and won't use it (095). That is why this records the vouch even on a no-op rename.
    if (body.kind === "rename") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) return NextResponse.json({ error: "A name is required." }, { status: 400 });
      if (name.length > 120) return NextResponse.json({ error: "That name is too long for a chat header." }, { status: 400 });
      const saved = await renameWhatsappVendor(authorId, name, actorFor(caller));
      return NextResponse.json({ ok: true, ...saved, name_confirmed: true });
    }

    if (body.kind === "send") {
      const text = typeof body.body === "string" ? body.body.trim() : "";
      if (!text) return NextResponse.json({ error: "empty message" }, { status: 400 });

      // Transport priority, most-official-first: Cloud API (business number, window must be open)
      // → WAHA bridge (when cleared to send) → Phase 1 wa.me keypress. The bridge is gated on the
      // same WHATSAPP_BRIDGE_ALLOW_SEND flag as the negotiator, so a human composer send from a
      // read-only deployment still goes out as a keypress, never programmatically. One row logged.
      const thread = await getWhatsappThread(authorId);
      const lastInbound = [...thread].reverse().find((m) => m.direction === "inbound");
      const windowOpen = serviceWindowOpen(lastInbound?.sent_at ?? lastInbound?.created_at);
      const digits = normalizeWaNumber(vendor.whatsapp_url);
      let apiError: string | null = null;
      const logSent = async (mode: string, waMessageId: string | null) => {
        const [row] = await insertWhatsappThreadMessages([{
          author_id: authorId, direction: "outbound", body: text, source: "composer",
          status: "sent", wa_message_id: waMessageId,
          sent_at: new Date().toISOString(), sent_by: actorFor(caller),
        }]);
        await clearWaSuggestionForAuthor(authorId).catch(() => {});
        return NextResponse.json({ ok: true, mode, message: row });
      };
      if (waCloudEnabled() && windowOpen && digits) {
        const sent = await sendWaText(digits, text);
        if (sent.ok) return logSent("api", sent.waMessageId);
        apiError = sent.error; // fall through — the message must still be sendable
      }
      if (waBridgeSendEnabled() && digits) {
        const sent = await sendViaBridge(digits, text);
        if (sent.ok) return logSent("bridge", sent.waMessageId);
        apiError = apiError ?? sent.error;
      }
      const [row] = await insertWhatsappThreadMessages([{
        author_id: authorId, direction: "outbound", body: text, source: "composer",
        sent_at: new Date().toISOString(), sent_by: actorFor(caller),
      }]);
      await clearWaSuggestionForAuthor(authorId).catch(() => {});
      // Null link means the vendor has no stored number — the message is still logged; the
      // person is sending from an existing chat on their phone anyway.
      return NextResponse.json({
        ok: true, mode: "manual", message: row, waUrl: waLink(vendor.whatsapp_url, text),
        windowClosed: waCloudEnabled() && !windowOpen, apiError,
      });
    }

    if (body.kind === "takeover") {
      // Take the thread out of AI management — the WA edition of the inbox takeover. Unlike the
      // email one it deletes nothing: the WA negotiator keeps no draft rows, and an agreed deal's
      // recap-email draft must survive a takeover. 'agreed'/'declined' stay what they are.
      const anchor = await getWaAnchor(authorId);
      if (!anchor) return NextResponse.json({ ok: true, alreadyYours: true }); // no anchor = nothing AI-managed yet
      if (!anchor.ai_managed) return NextResponse.json({ ok: true, alreadyYours: true });
      await supabaseAdmin.from("outreach_emails").update({
        ai_managed: false,
        ...(["agreed", "declined"].includes(anchor.negotiation_status ?? "") ? {} : { negotiation_status: "handoff" }),
        intervention_at: new Date().toISOString(),
      }).eq("id", anchor.id);
      return NextResponse.json({ ok: true, alreadyYours: false });
    }

    if (body.kind === "log") {
      const text = typeof body.body === "string" ? body.body.trim() : "";
      const direction = body.direction === "inbound" || body.direction === "outbound" ? body.direction : null;
      if (!text || !direction) return NextResponse.json({ error: "direction and body required" }, { status: 400 });
      const at = typeof body.at === "string" && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at).toISOString() : new Date().toISOString();
      const [row] = await insertWhatsappThreadMessages([{
        author_id: authorId, direction, body: text, source: "manual_paste",
        sent_at: at, sent_by: direction === "outbound" ? actorFor(caller) : null,
      }]);
      return NextResponse.json({ ok: true, message: row });
    }

    if (body.kind === "paste") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return NextResponse.json({ error: "empty paste" }, { status: 400 });

      // Deterministic first: WhatsApp's own export format. The LLM only breaks the tie on WHO
      // the vendor is when their phone-book name doesn't resemble ours, and a failed tie-break
      // REFUSES the paste — filing the vendor's words as ours would poison every later draft.
      const parsed = parseWaExport(text);
      let rows: Array<{ direction: "inbound" | "outbound"; body: string; at?: string | null }>;
      if (parsed) {
        let vendorSender = matchVendorSender(parsed.senders, vendor.name);
        if (!vendorSender) vendorSender = await identifyVendorSenderLLM(parsed.senders, vendor.name, text);
        if (!vendorSender) {
          return NextResponse.json({ error: `Couldn't tell which participant is ${vendor.name} (saw: ${parsed.senders.join(", ")}). Log the messages individually instead.` }, { status: 422 });
        }
        rows = parsed.messages.map((m) => ({ direction: m.sender === vendorSender ? "inbound" as const : "outbound" as const, body: m.body, at: m.at }));
      } else {
        const split = await splitPastedChat(text, vendor.name);
        if (!split) {
          return NextResponse.json({ error: "Couldn't read that paste as a conversation. Use \"Log their message\" for a single message, or paste a WhatsApp chat export." }, { status: 422 });
        }
        rows = split;
      }
      const inserted = await insertWhatsappThreadMessages(rows.map((r) => ({
        author_id: authorId, direction: r.direction, body: r.body, source: "manual_paste",
        sent_at: r.at ?? new Date().toISOString(),
        sent_by: r.direction === "outbound" ? actorFor(caller) : null,
      })));
      return NextResponse.json({ ok: true, inserted: inserted.length, messages: inserted });
    }

    if (body.kind === "draft") {
      const transcript = (await getWhatsappThread(authorId)).map((m) => ({ direction: m.direction, body: m.body }));
      const draft = await draftWhatsappReply({
        // Same rule the negotiator follows: an unconfirmed name is WhatsApp's pushname, and a
        // suggestion that greets the vendor wrongly is one the person will send by reflex.
        vendorName: addressableName(vendor),
        transcript,
        instruction: typeof body.instruction === "string" ? body.instruction : null,
        lang: isPitchLang(body.lang) ? body.lang : null,
        tone: isPitchTone(body.tone) ? body.tone : null,
      });
      return NextResponse.json({ ok: true, draft }); // a proposal — nothing written
    }

    return NextResponse.json({ error: "unknown kind" }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE /api/whatsapp/[authorId] — undo a mis-logged message ({ id }). Hand-logged rows only;
// the query refuses webhook/bridge rows so the thread can't be edited into a nicer story.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ authorId: string }> }) {
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { authorId } = await params;
  try {
    const { id } = await req.json();
    if (typeof id !== "string" || !id) return NextResponse.json({ error: "id required" }, { status: 400 });
    await deleteWhatsappThreadMessage(id, authorId);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
