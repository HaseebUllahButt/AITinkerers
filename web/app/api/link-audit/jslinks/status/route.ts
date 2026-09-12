import { NextResponse } from "next/server";
import { getJsLinksState } from "@/lib/linkaudit/jslinks";

// GET — live progress of an in-flight JS-links detector run. Rendering is jsdom in-process,
// so it is always available — no capability flag needed.
export async function GET() {
  const state = await getJsLinksState();
  const running = !!state && Date.now() - state.updatedAt < 10 * 60_000;
  return NextResponse.json({
    running,
    progress: state ? {
      runId: state.runId,
      pagesChecked: state.index,
      pagesTotal: state.pages.length,
      jsOnlyFound: state.jsOnlyFound,
      broken: state.brokenFound,
      renderFailed: state.renderFailed,
      log: state.log ?? [],
    } : null,
  });
}
