import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth/service";
import {
  createCrawlabilityCheck, createContentCheck, createFanOut,
  crawlabilityCheck, contentCheck, fanOut,
  CRAWLER_IDENTITIES, type Problem,
} from "@/lib/geo/otterly";

// Run a GEO audit, or read one back.
//
// ── Why the only writes in this surface live on their own route ─────────────────────────────────
//
// Each audit spends from a monthly quota — Otterly's own UI shows "1/100 GEO URL Audits used this
// month" next to the button — so one must never be started as a side effect of loading a page. A
// separate POST route means a run is always something a person clicked, and the page can put the cost
// on the button.
//
// GET polls one back by id: crawlability finishes in about eight seconds, a fan-out asks every engine
// and takes longer, so the client starts a run and then asks for it rather than holding a request open.
export const maxDuration = 60;

type Kind = "crawlability" | "content" | "fanout";

function kindOf(v: string | null): Kind | null {
  return v === "crawlability" || v === "content" || v === "fanout" ? v : null;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const kind = kindOf(String(body.kind ?? ""));
  const workspaceId = String(body.workspaceId ?? "").trim();
  if (!kind || !workspaceId) {
    return NextResponse.json({ ok: false, error: "kind and workspaceId are required" }, { status: 400 });
  }

  const problems: Problem[] = [];
  let created: { id: string; status: string } | null = null;

  if (kind === "fanout") {
    const query = String(body.query ?? "").trim();
    if (!query) return NextResponse.json({ ok: false, error: "query is required for a fan-out" }, { status: 400 });
    created = await createFanOut(workspaceId, query, problems);
  } else {
    const url = String(body.url ?? "").trim();
    // A URL is required and must be absolute: Otterly fetches it, and a bare domain is a 400 from them
    // rather than a helpful message from us.
    if (!/^https?:\/\/\S+$/i.test(url)) {
      return NextResponse.json({ ok: false, error: "url must be an absolute http(s) URL" }, { status: 400 });
    }
    if (kind === "crawlability") {
      created = await createCrawlabilityCheck(workspaceId, url, problems);
    } else {
      const identity = String(body.crawlerIdentity ?? "OAI-SearchBot");
      const ok = (CRAWLER_IDENTITIES as readonly string[]).includes(identity);
      created = await createContentCheck(workspaceId, url, ok ? identity : "OAI-SearchBot", problems);
    }
  }

  if (!created) {
    return NextResponse.json({ ok: false, error: problems[0]?.detail ?? "Otterly refused the run", problems }, { status: 502 });
  }
  return NextResponse.json({ ok: true, kind, ...created, problems });
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const kind = kindOf(req.nextUrl.searchParams.get("kind"));
  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!kind || !id) return NextResponse.json({ ok: false, error: "kind and id are required" }, { status: 400 });

  const problems: Problem[] = [];
  const result = kind === "crawlability" ? await crawlabilityCheck(id, problems)
    : kind === "content" ? await contentCheck(id, problems)
      : await fanOut(id, problems);
  return NextResponse.json({ ok: true, kind, result, problems });
}
