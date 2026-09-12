import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth/service";
import { listWorkspaces, workspaceTags, createTag, deleteTag, type Problem } from "@/lib/geo/otterly";

// Tags group prompts, and every report endpoint takes a tagId — so a tag is how "how do we do on
// video prompts specifically" becomes answerable. Free: tags cost nothing against any quota.
export const maxDuration = 60;

async function workspace(problems: Problem[]) {
  return (await listWorkspaces(problems))[0] ?? null;
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const problems: Problem[] = [];
  const ws = await workspace(problems);
  if (!ws) return NextResponse.json({ ok: false, error: "No Otterly workspace is readable.", problems }, { status: 502 });
  return NextResponse.json({ ok: true, items: await workspaceTags(ws.id, problems), problems });
}

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ ok: false, error: "name is required" }, { status: 400 });
  const problems: Problem[] = [];
  const ws = await workspace(problems);
  if (!ws) return NextResponse.json({ ok: false, error: "No Otterly workspace is readable.", problems }, { status: 502 });
  // Colour is required by the API. Defaulted rather than asked for: nobody opens a GEO dashboard to
  // pick a hex value, and the tag is a filter rather than a decoration.
  const created = await createTag(ws.id, name, String(body.color ?? "#0ea5e9"), problems);
  return created
    ? NextResponse.json({ ok: true, tag: created, problems })
    : NextResponse.json({ ok: false, error: problems[0]?.detail ?? "Otterly refused the tag", problems }, { status: 502 });
}

export async function DELETE(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const tagId = req.nextUrl.searchParams.get("tagId")?.trim();
  if (!tagId) return NextResponse.json({ ok: false, error: "tagId is required" }, { status: 400 });
  const problems: Problem[] = [];
  const ws = await workspace(problems);
  if (!ws) return NextResponse.json({ ok: false, error: "No Otterly workspace is readable.", problems }, { status: 502 });
  const gone = await deleteTag(ws.id, tagId, problems);
  return gone
    ? NextResponse.json({ ok: true, problems })
    : NextResponse.json({ ok: false, error: problems[0]?.detail ?? "Otterly refused the delete", problems }, { status: 502 });
}
