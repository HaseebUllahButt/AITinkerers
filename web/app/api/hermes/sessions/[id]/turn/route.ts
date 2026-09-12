import { NextRequest } from "next/server";
import { auth } from "@auth";
import { acquireLock, releaseLock } from "@/lib/redis";
import { getHermesSession } from "@/lib/db/queries";
import { runHermesTurn } from "@/lib/hermes/agent";
import type { StoredAttachment } from "@/lib/hermes/attachments";

// A Hermes turn can chain several tool round-trips (each with its own model latency) — same
// reasoning as the writer's turn route, same envelope (`data: ${JSON.stringify(x)}\n\n`) so the
// existing manual getReader() client pattern works unmodified.
export const maxDuration = 300;

// POST { message } — run one human turn and stream progress as SSE.
//
// Also accepts POST { continuation: true } with NO message: the client resuming a turn that this
// route's own `done.needsContinuation` asked to have resumed. Summer's continuation is client-driven,
// one POST per segment, where the writer runs its segment loop server-side.
//
// This used to say "Unlike the writer there is no machine-continuation loop: a chat turn either
// finishes inside its round budget or tells the user what it ran out of doing. The person continues by
// replying, which is how chat already works." That stopped being the intent when the server started
// setting `needsContinuation` — but the empty-message guard below still rejected every continuation, so
// the described behaviour survived as a 400.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const { id } = await params;

  const session = await getHermesSession(id).catch(() => null);
  if (!session) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  if (session.user_email !== email) return new Response(JSON.stringify({ error: "not yours" }), { status: 403 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const message = typeof (body as { message?: unknown }).message === "string" ? (body as { message: string }).message : "";
  // Attachments were stored by the attachments route before this call; what arrives here is the
  // record of that, not the bytes. An attachment-only message is legitimate — dropping a screenshot
  // with no words is a perfectly clear thing to do — so the empty-message check accounts for it.
  const attachments = Array.isArray((body as { attachments?: unknown }).attachments)
    ? ((body as { attachments: StoredAttachment[] }).attachments).slice(0, 10)
    : [];
  // A continuation is the CLIENT resuming a turn the server itself asked to have resumed: the round
  // budget filled or the deadline passed, `done.needsContinuation` said so, and no human typed
  // anything. It legitimately carries no message.
  //
  // Without this branch the loop could not run at all — the client posted an empty message and got
  // 400 "message is required" back, which is what the transcript showed as "message is required /
  // Response failed" at the exact point a landing-page fill should have carried on by itself. The
  // comment that used to sit at the top of this file ("Unlike the writer there is no machine-
  // continuation loop") described that gap accurately; the loop was added on both sides around it.
  const continuation = (body as { continuation?: unknown }).continuation === true;
  if (!continuation && !message.trim() && !attachments.length) {
    return new Response(JSON.stringify({ error: "message is required" }), { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: object) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { closed = true; }
      };
      // ── One turn per session at a time ──────────────────────────────────────────────────────
      //
      // Without this, two turns on one session interleave their appends and PERMANENTLY corrupt the
      // transcript: a tool_result has to sit in the message immediately after its tool_use, and two
      // turns each waiting on a different tool write in whichever order they finish. Measured on a
      // real 73-message session — an assistant tool_use at seq 62, a result for a different id at
      // 63, and 62's own result at 66. Every later turn replayed that and got a 400, so the session
      // was unusable and no amount of retrying could fix it.
      //
      // The client's own runningRef guard is per-TAB, which is why it did not prevent this: a second
      // tab, or a reload mid-turn, walks straight past it. This is the guard that actually holds.
      //
      // TTL matches the turn budget plus margin, so a crashed holder cannot lock a session out — the
      // lock expires on its own rather than needing an admin to clear it. `acquireLock` returns true
      // when Redis is absent (local dev, single instance), so this cannot break a dev machine.
      const lockKey = `hermes:turn:${id}`;
      const lockToken = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const got = await acquireLock(lockKey, 330, lockToken).catch(() => true);
      if (!got) {
        // A refusal, not a failure: nothing was written, and saying so is what stops somebody hitting
        // send again and making it worse.
        send({
          t: "error",
          message:
            "This conversation already has a turn running. Wait for it to finish before sending again — " +
            "two at once would corrupt the transcript. If you have it open in another tab, that is why.",
        });
        send({ t: "done" });
        controller.close();
        return;
      }

      try {
        await runHermesTurn(id, message, send, attachments, { continuation });
      } catch (e: unknown) {
        send({ t: "error", message: e instanceof Error ? e.message : "Turn failed." });
      } finally {
        await releaseLock(lockKey, lockToken).catch(() => {});
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
