import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth/service";
import { otterlyCountry, citationPrompts, citationHistory, type Problem } from "@/lib/geo/otterly";

// One cited page, in depth: which prompts produced an answer citing it, and how its citation count
// moved against the preceding window.
//
// Separate from the overview because it is per-URL and there are sixty of them — fetching this for
// every row would be 120 requests to render something nobody has clicked. Two calls when a row opens.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const reportId = q.get("reportId")?.trim();
  const url = q.get("url")?.trim();
  const startDate = q.get("startDate")?.trim();
  const endDate = q.get("endDate")?.trim();
  const country = q.get("country")?.trim() || otterlyCountry();
  const engines = (q.get("engines") ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  const tagId = q.get("tagId")?.trim() || undefined;
  if (!reportId || !url || !startDate || !endDate) {
    return NextResponse.json({ ok: false, error: "reportId, url, startDate and endDate are required" }, { status: 400 });
  }
  const problems: Problem[] = [];
  const f = { engines: engines.length ? engines : undefined, tagId };
  const [prompts, history] = await Promise.all([
    citationPrompts(reportId, url, startDate, endDate, country, problems, f),
    citationHistory(reportId, url, startDate, endDate, country, problems, f),
  ]);
  return NextResponse.json({ ok: true, url, prompts, history, problems });
}
