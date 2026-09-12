import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { openProposalPr } from "@/lib/indexing/repo";
import type { ChangeRequestPreview } from "@/lib/indexing/routing";
import { logDispatch } from "@/lib/indexing/persist";
import { postToSlack } from "@/lib/linkaudit/slack";
import { prReviewMessage, prNoRepoMessage, sectionsOf } from "@/lib/indexing/prNotify";

export const maxDuration = 60;

// Opens a real GitHub PR for one routing preview, in the repo that renders the page (resolved
// from REPO_MAP → preview.repo). Session-only (no CRON_SECRET path) — this is a write action
// visible to others and must always be a deliberate human click, never an automated call.
export async function POST(req: NextRequest) {
  const session = await auth().catch(() => null);
  if (!session?.user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const preview = body?.preview as ChangeRequestPreview | undefined;
  const runId: string | null = body?.runId ?? null;
  if (!preview || preview.kind !== "pr") {
    return NextResponse.json({ ok: false, error: "expected a PR-routed preview" }, { status: 400 });
  }

  // No repo mapped for this page's section → don't open a PR. Post a Slack notice and tell the
  // UI to ask the user to add the mapping (per the agreed behavior — no default fallback repo).
  if (!preview.repo) {
    const sections = sectionsOf(preview.urls);
    await postToSlack(prNoRepoMessage(preview.title, sections, preview.urls.length)).catch(() => {});
    await logDispatch({
      runId, kind: "pr", reason: preview.reason, title: preview.title,
      status: "error", error: "no repo mapped for section", dispatchedBy: session.user.email,
    });
    return NextResponse.json({
      ok: false,
      needsRepoMapping: true,
      sections,
      message: `No repo mapped for ${sections.join(", ") || "this page's section"} — add it to REPO_MAP, then retry.`,
    });
  }

  try {
    const pr = await openProposalPr(preview, new Date().toISOString());
    await postToSlack(prReviewMessage(preview.title, preview.repo, pr.url)).catch(() => {});
    await logDispatch({
      runId,
      kind: "pr",
      reason: preview.reason,
      title: preview.title,
      targetRef: pr.url,
      status: "ok",
      dispatchedBy: session.user.email,
    });
    return NextResponse.json({ ok: true, pr });
  } catch (e: any) {
    const message = e?.message ?? "PR creation failed";
    await logDispatch({
      runId,
      kind: "pr",
      reason: preview.reason,
      title: preview.title,
      status: "error",
      error: message,
      dispatchedBy: session.user.email,
    });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
