import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth/service";
import {
  otterlyEnabled, otterlyCountry, otterlyReportId, otterlyEnvSeen,
  listWorkspaces, listBrandReports, brandStats, brandPrompts,
  brandCitations, brandCitationStats, brandRecommendations, agentStats,
  listEngines, accountInfo, agentAgents, agentPages,
  crawlabilityChecks, crawlabilityCheck, contentChecks, fanOuts, fanOut,
  workspaceTags, workspacePrompts,
  type Problem,
} from "@/lib/geo/otterly";

// The GEO page's data, in one request.
//
// One round trip rather than eight, because the page is a single screen and eight spinners resolving
// at different moments reads as eight separate broken things.
//
// ── Why the ids are resolved here and not in the client ─────────────────────────────────────────
//
// Every useful Otterly call needs a brand report id, and getting one is two calls that the page has no
// business knowing about (workspaces → reports). Resolving server-side also keeps the API key on the
// server, which is the actual requirement: OTTERLY_API_KEY must never reach the browser.
//
// ── Why `problems` is a list and not an error ───────────────────────────────────────────────────
//
// Eight calls can fail independently. Citations can 403 on a plan that has visibility but not the
// citations add-on, while stats returns fine. Collapsing that into a single 500 would throw away seven
// good panels to report one bad one — so each failure is named and the page renders what it has.
export const maxDuration = 60;

/** Otterly wants plain YYYY-MM-DD, inclusive at both ends. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const days = Math.max(1, Math.min(Number(req.nextUrl.searchParams.get("days")) || 30, 90));
  const country = req.nextUrl.searchParams.get("country")?.trim().toLowerCase() || otterlyCountry();
  // The two filters every report endpoint accepts. Repeated params, not comma-joined — see Filters in
  // otterly.ts; a comma-joined engines list is silently ignored rather than rejected.
  // Named engineFilter, not `engines`: the /v1/engines RESULT is also called engines further down, and
  // one shadowing the other is a filter that silently stops being applied.
  const engineFilter = (req.nextUrl.searchParams.get("engines") ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  const tagId = req.nextUrl.searchParams.get("tagId")?.trim() || undefined;
  const filters = { engines: engineFilter.length ? engineFilter : undefined, tagId };
  const now = new Date();
  // ── endDate is TODAY, and the first version of this was wrong ─────────────────────────────────
  //
  // It used yesterday, reasoning that Otterly's runs land through the day so a window ending today
  // would be partial and read as a collapse in visibility. Measured against the live account, that
  // reasoning cost the page everything it had: the prompts were created and first run on the 28th, so
  // a 30-day window ending on the 27th returned `status: "no_data"` and every figure zero, while the
  // same call ending on the 28th returned `status: "finished"`, 15 prompts and 76 mentions.
  //
  // The guess was also unnecessary. Otterly reports `status` and `isRecalculating` on the response, so
  // whether a window is complete is a fact we are told rather than one we have to protect against by
  // discarding the most recent day — which on a young report is most of the data.
  const end = now;
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const startDate = isoDate(start);
  const endDate = isoDate(end);

  const problems: Problem[] = [];

  if (!otterlyEnabled()) {
    // Names only. See otterlyEnvSeen — this is what tells a misnamed variable apart from a missing one
    // and from a deployment that simply predates it, which are three different fixes that otherwise
    // look identical from the browser.
    return NextResponse.json({
      ok: true, configured: false, days, country, startDate, endDate,
      envSeen: otterlyEnvSeen(),
      problems: [], report: null, stats: null, prompts: [], citations: [],
      citationStats: null, recommendations: [], agents: null,
    });
  }

  try {
    // ── Resolve the report ────────────────────────────────────────────────────────────────────────
    let reportId = otterlyReportId();
    let report = null;
    const workspaces = await listWorkspaces(problems).catch(() => []);
    if (reportId) {
      // Pinned by env. Still listed, because the page shows which brand and which competitors the
      // numbers are about, and that only comes from the report row.
      const all = await listBrandReports(problems);
      report = all.find((r) => r.id === reportId) ?? null;
      if (!report && all.length) {
        problems.push({
          call: "/v1/reports/brand",
          detail: `OTTERLY_REPORT_ID is set to ${reportId}, which is not in this account. Found: ${
            all.map((r) => `${r.reportTitle || r.brand} (${r.id})`).join(", ")}`,
        });
        reportId = null;
      }
    } else {
      const reports = await listBrandReports(problems, workspaces[0]?.id);
      report = reports[0] ?? null;
      reportId = report?.id ?? null;
      if (reports.length > 1) {
        problems.push({
          call: "/v1/reports/brand",
          detail: `${reports.length} brand reports exist and none is pinned, so the first was used `
            + `("${report?.reportTitle || report?.brand}"). Set OTTERLY_REPORT_ID to choose.`,
        });
      }
    }

    if (!reportId) {
      return NextResponse.json({
        ok: true, configured: true, days, country, startDate, endDate,
        appliedEngines: engineFilter, appliedTagId: tagId ?? null,
        problems, report: null, stats: null, prompts: [], citations: [],
        citationStats: null, recommendations: [], agents: null,
        workspace: workspaces[0] ?? null, engines: [], account: null, tags: [], workspacePrompts: [],
        agentDetail: null, audits: { crawlability: [], content: [], fanOuts: [] },
      });
    }

    // ── Everything else, together ─────────────────────────────────────────────────────────────────
    //
    // Thirteen calls now rather than six. They run concurrently and every one is cached for 15 minutes,
    // so a reload costs nothing — which matters against a 1,000-request monthly API cap. The audit
    // LISTS are read here; creating an audit is a POST on its own route, because each one spends from a
    // quota and must never happen on a page load.
    const wsId = workspaces[0]?.id;
    const [
      stats, prompts, citations, citationStats, recommendations, agents,
      engines, account, agents2, pages2, crawls, contents, fans, tags, wsPrompts,
    ] = await Promise.all([
      brandStats(reportId, startDate, endDate, country, problems, filters),
      brandPrompts(reportId, startDate, endDate, country, problems, 60, filters),
      brandCitations(reportId, startDate, endDate, country, problems, 60, filters),
      brandCitationStats(reportId, startDate, endDate, country, problems, filters),
      brandRecommendations(reportId, country, problems),
      agentStats(reportId, startDate, endDate, problems),
      listEngines(problems, country),
      accountInfo(problems),
      agentAgents(reportId, problems),
      agentPages(reportId, problems),
      crawlabilityChecks(problems),
      contentChecks(problems),
      wsId ? fanOuts(wsId, problems) : Promise.resolve([]),
      wsId ? workspaceTags(wsId, problems) : Promise.resolve([]),
      wsId ? workspacePrompts(wsId, problems) : Promise.resolve([]),
    ]);

    // The newest crawlability check, expanded. The list rows carry only url+date; the per-bot verdicts
    // — the whole point — are only on the detail.
    const newestCrawl = crawls[0] ? await crawlabilityCheck(crawls[0].id, problems) : null;
    // Same for fan-outs: the list has no expandedQueries on it.
    const newestFan = fans[0] ? await fanOut(fans[0].id, problems) : null;

    return NextResponse.json({
      ok: true, configured: true, days, country, startDate, endDate,
      report, stats, prompts, citations, citationStats, recommendations, agents, problems,
      appliedEngines: engineFilter, appliedTagId: tagId ?? null,
      workspace: workspaces[0] ?? null, engines, account, tags, workspacePrompts: wsPrompts,
      agentDetail: { agents: agents2.items, pages: pages2.items },
      audits: {
        crawlability: crawls, crawlabilityDetail: newestCrawl,
        content: contents, fanOuts: fans, fanOutDetail: newestFan,
      },
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "load failed" },
      { status: 500 },
    );
  }
}
