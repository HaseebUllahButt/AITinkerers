import { NextResponse } from "next/server";
import { requestJsLinksStop } from "@/lib/linkaudit/jslinks";

// POST — durable stop for the JS-links detector: a Redis flag the running chunk checks
// before every page, on whichever instance (or QStash continuation) is executing it.
export async function POST() {
  await requestJsLinksStop();
  return NextResponse.json({ stopping: true });
}
