import { NextRequest, NextResponse } from "next/server";
import { getCampaign, updateCampaign } from "@/lib/db/queries";
import { runDiscoveryPipeline } from "@/lib/pipeline/run";

export const maxDuration = 300;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const campaign = await getCampaign(id);
  if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

  await updateCampaign(id, { status: "running" });

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
        const { runId, stats } = await runDiscoveryPipeline(
          (progress) => send(progress),
          { campaignId: id, customKeywords: campaign.keywords }
        );
        send({ stage: "done", runId, stats });
      } catch (e: any) {
        await updateCampaign(id, { status: "done" });
        send({ stage: "error", message: e?.message ?? "Unknown error" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
