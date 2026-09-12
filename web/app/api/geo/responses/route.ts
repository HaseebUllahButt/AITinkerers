import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth/service";
import { otterlyCountry, promptResponses, type Problem } from "@/lib/geo/otterly";

// What the engines actually SAID for one prompt.
//
// On its own route, and fetched only when somebody opens a row, because this is the most expensive
// thing on the page in request terms: 15 prompts is 15 calls against a 1,000-request monthly cap, to
// render text nobody has asked to read. Coverage tells you 13 of 15 prompts never mention us; this
// tells you what they said instead, with the citations inline — which is the difference between a
// number and a brief somebody can act on.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const reportId = req.nextUrl.searchParams.get("reportId")?.trim();
  const promptId = req.nextUrl.searchParams.get("promptId")?.trim();
  const startDate = req.nextUrl.searchParams.get("startDate")?.trim();
  const endDate = req.nextUrl.searchParams.get("endDate")?.trim();
  const country = req.nextUrl.searchParams.get("country")?.trim() || otterlyCountry();
  if (!reportId || !promptId || !startDate || !endDate) {
    return NextResponse.json({ ok: false, error: "reportId, promptId, startDate and endDate are all required" }, { status: 400 });
  }

  const problems: Problem[] = [];
  const items = await promptResponses(reportId, promptId, startDate, endDate, country, problems);
  return NextResponse.json({ ok: true, items, problems });
}
