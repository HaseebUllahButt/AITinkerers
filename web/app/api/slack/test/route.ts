import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { hasWebhook, postToSlack } from "@/lib/linkaudit/slack";
import { composeSlackPreview } from "@/lib/indexing/slackPreview";
import { prReviewMessage, prNoRepoMessage } from "@/lib/indexing/prNotify";
import type { IndexingReport } from "@/lib/indexing/types";

export const maxDuration = 60;

// Hardcoded test label — ONLY on the messages this route sends, so teammates know to ignore
// them. Production senders are deliberately NOT prefixed.
const TEST_LABEL = "*Testing for SEO tool — please ignore*";

async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const header = req.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  const session = await auth().catch(() => null);
  return !!session;
}

// Minimal but valid IndexingReport so we exercise the REAL page-health composer (not a mock of it).
const SAMPLE_REPORT = {
  target: "northwind.example",
  analyzed: 20,
  counts: { verdicts: { pass: 14, flag: 5, block: 1 }, jsGated: 3, templates: 6, issues: 8, p0: 1 },
  urls: [],
  templates: [],
  cwv: [],
  routing: [],
} as unknown as IndexingReport;

const SAMPLE_REPO = { owner: "Vyro-ai", repo: "marketing-web", baseBranch: "main", section: "/ai-image-generator" };

// One labeled sample per message type. Where a composer is cheaply reusable we call the real one
// (page-health preview, PR notifications); the digest-style messages are representative samples in
// the exact production format.
function samples(): { type: string; text: string }[] {
  return [
    {
      type: "link-audit digest",
      text: [
        ":link: *northwind.example link audit*",
        "Found *2* broken links across 1,482 pages checked.",
        ":writing_hand: *By author*",
        "• <https://northwind.example/blog/sample|/blog/sample> — 404 (dead outbound link)",
      ].join("\n"),
    },
    {
      type: "page-health preview",
      text: composeSlackPreview(SAMPLE_REPORT),
    },
    {
      type: "GEO citation share",
      text: [
        ":mag: *AI citation check — Northwind*",
        "Appears in *40%* of AI answers (5 answers across 2 engines: Perplexity, Gemini).",
        "*Source gaps* (sites the AI cites for competitors, not us):",
        "• zapier.com (2)",
      ].join("\n"),
    },
    {
      type: "backlinks list share",
      text: [
        ":link: *Backlink prospects — AI image generator*",
        "Top 3 of 42 prospects:",
        "• techradar.com — DR 91",
      ].join("\n"),
    },
    {
      type: "internal-links digest",
      text: [
        ":link: *Internal-link opportunities*",
        "Found *7* new opportunities in last night's sweep.",
        "• /blog/how-to → /ai-image-generator (linkify \"AI image generator\")",
      ].join("\n"),
    },
    {
      type: "PR review notification",
      text: prReviewMessage("[SEO] Missing canonical — 3 pages", SAMPLE_REPO, "https://github.com/Vyro-ai/marketing-web/pull/123"),
    },
    {
      type: "PR no-repo notice",
      text: prNoRepoMessage("[SEO] Missing canonical — 2 pages", ["/pricing", "/tools"], 2),
    },
  ];
}

// Sends one clearly-labeled sample per Slack message type so every send path can be verified
// without spamming the channel with unlabeled production-looking messages.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await hasWebhook())) {
    return NextResponse.json({
      ok: false,
      error: "No Slack webhook configured. Add it in Site Audit → Broken links → Slack settings first.",
    }, { status: 400 });
  }

  const results: { type: string; ok: boolean; error?: string }[] = [];
  for (const s of samples()) {
    const r = await postToSlack(`${TEST_LABEL}\n${s.text}`);
    results.push({ type: s.type, ok: r.ok, error: r.error });
  }
  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({ ok: okCount === results.length, sent: okCount, total: results.length, results });
}
