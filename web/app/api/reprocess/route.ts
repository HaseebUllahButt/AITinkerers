import { NextRequest, NextResponse } from "next/server";
import { runReprocessPipeline } from "@/lib/pipeline/run";
import { countUnprofiledHits } from "@/lib/db/queries";

export const maxDuration = 300;

export async function GET() {
  const counts = await countUnprofiledHits();
  return NextResponse.json(counts);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { source, campaign_id } = body;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (data: object) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };
      try {
        const { runId, stats } = await runReprocessPipeline(
          { source: source ?? undefined, campaignId: campaign_id ?? undefined },
          (progress) => send(progress)
        );
        send({ stage: "done", runId, stats });
      } catch (e: any) {
        send({ stage: "error", message: e?.message ?? "Unknown error" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
}
