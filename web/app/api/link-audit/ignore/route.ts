import { NextRequest, NextResponse } from "next/server";
import { getIgnoredLinks, addIgnoredLink, removeIgnoredLink } from "@/lib/linkaudit/ignore";
import { supabaseAdmin } from "@/lib/db/supabase";

// GET — the current ignore list (links the crawler skips).
export async function GET() {
  return NextResponse.json({ ignored: await getIgnoredLinks() });
}

// POST { link } — ignore a link: add it to the skip list AND purge its existing findings so it
// disappears from the current results immediately.
export async function POST(req: NextRequest) {
  try {
    const { link } = await req.json().catch(() => ({}));
    if (!link || typeof link !== "string") return NextResponse.json({ error: "link required" }, { status: 400 });
    await addIgnoredLink(link);
    await supabaseAdmin.from("link_audit_findings").delete().eq("link_url", link.trim());
    return NextResponse.json({ ok: true, ignored: await getIgnoredLinks() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "failed" }, { status: 500 });
  }
}

// DELETE ?link= — un-ignore a link (it'll be checked again on the next run).
export async function DELETE(req: NextRequest) {
  const link = req.nextUrl.searchParams.get("link");
  if (!link) return NextResponse.json({ error: "link required" }, { status: 400 });
  await removeIgnoredLink(link);
  return NextResponse.json({ ok: true, ignored: await getIgnoredLinks() });
}
