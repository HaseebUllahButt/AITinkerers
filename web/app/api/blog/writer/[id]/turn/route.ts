import { NextRequest } from "next/server";
import { auth } from "@auth";
import { runTurn, needsMachineContinuation } from "@/lib/writer/agent";
import type { WriterSession } from "@/lib/db/queries";

// A writer turn can involve several research round-trips (each with its own model latency) before
// it produces anything — comfortably past a typical proxy timeout if it were a plain JSON response.
export const maxDuration = 300;

/**
 * Wall clock for one request. `runTurn` is bounded by MAX_INTERNAL_ROUNDS, not by time, so a segment
 * can take a while; this leaves headroom under maxDuration to close the stream cleanly and tell the
 * client to continue, rather than being killed mid-write.
 */
const REQUEST_BUDGET_MS = 210_000;

/** Backstop against a phase that refuses to advance. Each segment is up to 8 model round-trips, so
 *  this is generous; it exists so a stuck session cannot spin, not to bound normal work. */
const MAX_SEGMENTS = 6;

/** Cheap fingerprint of "has anything actually progressed". If a whole segment moves none of these,
 *  continuing would just repeat it — stop and hand back to the human instead of looping. */
function progressSignature(session: WriterSession): string {
  const sections = Object.keys(session.sections ?? {}).length;
  const research = session.research as { sources?: Record<string, unknown> } | null;
  const sources = Object.keys(research?.sources ?? {}).length;
  return `${session.phase}:${sections}:${session.section_cursor}:${sources}`;
}

// POST { message? } — run a human turn and stream progress as SSE, using this repo's existing
// envelope (`data: ${JSON.stringify(x)}\n\n`, matching src/app/api/reprocess/route.ts) rather than
// the Anthropic SDK's raw stream-event shape. Two reasons: the client-side reader for this exact
// wire format already exists (src/app/page.tsx's manual getReader() loop) and works unmodified, and
// this needs to multiplex events the SDK has no type for — phase transitions, the approved outline,
// which draft to refetch — not just model deltas.
//
// One request can run SEVERAL agent turns. Research and section-writing are machine-driven phases
// with nothing for a human to add, and `runTurn`'s round cap would otherwise end the request in the
// middle of them — which is exactly what made the writer look like it gave up: a wall of tool calls,
// no conclusion, phase still "researching". So the request keeps going while
// `needsMachineContinuation` holds, and stops only at a phase that genuinely needs a person, or when
// it runs out of time — in which case `done.needs_continuation` tells the client to open a fresh
// request and carry on.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const message = typeof (body as any)?.message === "string" ? (body as any).message : undefined;

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: object) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { closed = true; }
      };
      try {
        // Only the first segment carries the human's message; continuations are the machine driving
        // itself, so they pass undefined.
        let session = await runTurn(id, message, send);
        let segments = 1;

        while (session && needsMachineContinuation(session)) {
          if (segments >= MAX_SEGMENTS || Date.now() - startedAt > REQUEST_BUDGET_MS) {
            send({ t: "done", phase: session.phase, needs_continuation: true });
            return;
          }

          const before = progressSignature(session);
          send({ t: "continuing", phase: session.phase, segment: segments });
          session = await runTurn(id, undefined, send);
          segments++;

          if (session && progressSignature(session) === before) {
            // A whole segment changed nothing. Continuing would repeat it, so surface it as needing a
            // person rather than burning turns in a loop.
            send({
              t: "stalled",
              phase: session.phase,
              message: "That step didn't move forward. Tell it what to do differently, or send again to retry.",
            });
            send({ t: "done", phase: session.phase, needs_continuation: false });
            return;
          }
        }
      } catch (e: any) {
        send({ t: "error", message: e?.message ?? "Turn failed." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
