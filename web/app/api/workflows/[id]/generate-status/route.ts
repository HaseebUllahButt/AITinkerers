import { NextRequest, NextResponse } from "next/server";
import { getGen } from "@/lib/email/genBuffer";

// Progress of an in-flight (or just-finished) generation for this workflow.
// ?channel=linkedin polls the LinkedIn-note generation and ?channel=revise the workflow-wide
// pitch rewrite (each keyed separately) so concurrent runs don't clobber each other's progress.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const channel = req.nextUrl.searchParams.get("channel");
  // The buffer lives in Upstash, whose free tier stops answering once its monthly request quota
  // is spent (every call throws "max requests limit exceeded"). That is "cannot know", which is
  // not the same answer as "not running" — a poller reading zeros here would announce "applied
  // to 0 of 0 pitches" over a run that is still working. So the failure is its own field, and
  // done/total are omitted claims, not values.
  let gen;
  try {
    gen = await getGen(channel === "linkedin" || channel === "revise" ? `${id}:${channel}` : id);
  } catch (e) {
    return NextResponse.json({
      running: false, done: 0, total: 0, errors: [],
      unavailable: true,
      error: `The progress tracker did not answer (${e instanceof Error ? e.message : "read failed"}). A run may still be working — check the pitches themselves.`,
    });
  }
  if (!gen) return NextResponse.json({ running: false, done: 0, total: 0, errors: [] });
  return NextResponse.json({
    running: gen.running,
    done: gen.done,
    total: gen.total,
    errors: gen.errors,
  });
}
