import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";
import { postToSlack, composeAuditDigest, resolveAuthorIds, hasBotToken } from "@/lib/linkaudit/slack";

// Hardcoded test label so teammates ignore these — this is a test endpoint, not production.
const TEST_LABEL = "*Testing for SEO tool — please ignore*";

// Known site authors used to exercise the fuzzy matcher in the tag test even when the
// latest run's findings happen to be on authorless pages.
const SAMPLE_AUTHORS = ["Tooba Siddiqui", "Saba Sohail", "Areeba Imran", "Arooj Ishtiaq", "Ryan Hayden", "Umaima Shah", "Sameer Sohail"];

// POST — send a test message to the configured Slack webhook. If a completed run exists, sends
// its real digest text (the truest test) but PREFIXED with the test label so nobody acts on it;
// otherwise a simple hello. Then a tag test: resolves author names → member IDs (manual map
// first, then fuzzy search of the workspace directory via the bot token) and posts the result.
export async function POST() {
  const { data: lastRun } = await supabaseAdmin
    .from("link_audit_runs").select("id").eq("status", "completed")
    .order("started_at", { ascending: false }).limit(1).maybeSingle();

  // Compose (don't auto-post) so we can prefix the test label before sending.
  let res: { ok: boolean; error?: string };
  if (lastRun) {
    const composed = await composeAuditDigest(lastRun.id);
    res = "text" in composed
      ? await postToSlack(`${TEST_LABEL}\n${composed.text}`)
      : { ok: false, error: composed.error };
  } else {
    res = await postToSlack(`${TEST_LABEL}\n:link: *imagine.art link audit* — test message from SearchOps. The webhook works; daily digests will arrive here.`);
  }
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 500 });

  // Authors from the latest run's findings + known site authors, deduped.
  const { data: found } = lastRun
    ? await supabaseAdmin.from("link_audit_findings").select("page_author").eq("run_id", lastRun.id).not("page_author", "is", null)
    : { data: [] as any[] };
  const authors = [...new Set([...(found ?? []).map((r: any) => r.page_author), ...SAMPLE_AUTHORS])] as string[];

  const botConfigured = await hasBotToken();
  const resolved = await resolveAuthorIds(authors);
  const lines = authors.map((a) => resolved[a] ? `• ${a} → <@${resolved[a]}>` : `• ${a} → _no match in workspace_`);
  await postToSlack(
    `${TEST_LABEL}\n:label: *Author tag test* — ${botConfigured ? "fuzzy-matched against the workspace directory" : "no bot token set: manual map only (add an xoxb- token on the Link Audit page for automatic matching)"}:\n${lines.join("\n")}`
  );

  return NextResponse.json({ ok: true, usedRealDigest: !!lastRun, botConfigured, matched: Object.keys(resolved).length, tested: authors.length });
}
