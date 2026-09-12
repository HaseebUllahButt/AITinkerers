import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth/service";
import {
  otterlyCountry, listWorkspaces, listBrandReports, otterlyReportId,
  workspacePrompts, createPrompts, deletePrompt, setPromptTags, type Problem,
} from "@/lib/geo/otterly";

// The prompts Otterly measures — read, add, retag, remove.
//
// ── Why this is a route and not part of the overview ────────────────────────────────────────────
//
// The prompts ARE the measurement: everything on /geo is downstream of which questions get asked. So
// being able to add one without leaving SearchOps is the difference between "we should track that" and
// tracking it — a coverage gap becomes a measured prompt in one click.
//
// Adding spends from the plan's prompt allowance (50 here, 15 used), so it is a POST behind a button
// with the remaining count on it, never a page-load side effect. DELETE is genuinely destructive — it
// discards that prompt's measurement history — so it is here for the UI and deliberately NOT given to
// Summer as a tool.
export const maxDuration = 60;

async function ids(problems: Problem[]) {
  const ws = (await listWorkspaces(problems))[0] ?? null;
  const pinned = otterlyReportId();
  const reports = await listBrandReports(problems, ws?.id);
  const report = (pinned ? reports.find((r) => r.id === pinned) : reports[0]) ?? null;
  return { ws, report };
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const problems: Problem[] = [];
  const { ws } = await ids(problems);
  if (!ws) return NextResponse.json({ ok: false, error: "No Otterly workspace is readable.", problems }, { status: 502 });
  const items = await workspacePrompts(ws.id, problems);
  return NextResponse.json({ ok: true, items, workspace: ws, problems });
}

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const prompts = Array.isArray(body.prompts) ? (body.prompts as unknown[]).map((p) => String(p).trim()).filter(Boolean) : [];
  if (!prompts.length) return NextResponse.json({ ok: false, error: "prompts must be a non-empty array" }, { status: 400 });

  const problems: Problem[] = [];
  const { ws, report } = await ids(problems);
  if (!ws) return NextResponse.json({ ok: false, error: "No Otterly workspace is readable.", problems }, { status: 502 });

  // Refuse before spending. The API would answer with its own error, but a request spent to learn we
  // are over quota is a request wasted against a 1,000-a-month cap.
  const remaining = ws.promptsMaxCount - ws.promptsUsedCount;
  if (prompts.length > remaining) {
    return NextResponse.json({
      ok: false,
      error: `${prompts.length} prompts, but only ${remaining} of ${ws.promptsMaxCount} remain on this plan.`,
    }, { status: 400 });
  }

  const created = await createPrompts(ws.id, {
    prompts,
    country: String(body.country ?? "").trim().toLowerCase() || otterlyCountry(),
    tagIds: Array.isArray(body.tagIds) ? (body.tagIds as unknown[]).map(String) : undefined,
    // Attached to the report, or the prompt exists in the workspace and appears in no report.
    brandReportIds: report ? [report.id] : undefined,
  }, problems);

  if (!created) return NextResponse.json({ ok: false, error: problems[0]?.detail ?? "Otterly refused the prompts", problems }, { status: 502 });
  return NextResponse.json({ ok: true, added: created.length, items: created, problems });
}

export async function PATCH(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const promptId = String(body.promptId ?? "").trim();
  const tagIds = Array.isArray(body.tagIds) ? (body.tagIds as unknown[]).map(String) : [];
  if (!promptId) return NextResponse.json({ ok: false, error: "promptId is required" }, { status: 400 });

  const problems: Problem[] = [];
  const { ws } = await ids(problems);
  if (!ws) return NextResponse.json({ ok: false, error: "No Otterly workspace is readable.", problems }, { status: 502 });
  const r = await setPromptTags(ws.id, promptId, tagIds, problems);
  return r
    ? NextResponse.json({ ok: true, result: r, problems })
    : NextResponse.json({ ok: false, error: problems[0]?.detail ?? "Otterly refused the change", problems }, { status: 502 });
}

export async function DELETE(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const promptId = req.nextUrl.searchParams.get("promptId")?.trim();
  if (!promptId) return NextResponse.json({ ok: false, error: "promptId is required" }, { status: 400 });

  const problems: Problem[] = [];
  const { ws } = await ids(problems);
  if (!ws) return NextResponse.json({ ok: false, error: "No Otterly workspace is readable.", problems }, { status: 502 });
  const gone = await deletePrompt(ws.id, promptId, problems);
  return gone
    ? NextResponse.json({ ok: true, problems })
    : NextResponse.json({ ok: false, error: problems[0]?.detail ?? "Otterly refused the delete", problems }, { status: 502 });
}
