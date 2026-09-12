import { NextRequest, NextResponse } from "next/server";
import { ingestLines, type IngestLine } from "@/lib/geo/store";

// Where imagine.art's access logs arrive.
//
// ── Why this is a shared-secret endpoint and not a session one ───────────────────────────────────
//
// The caller is not a person and never will be: it is a Vercel log drain, a Cloudflare Worker, or a
// one-line forward in imagine-web's own middleware. None of those can hold a browser session. So the
// gate is a bearer token in GEO_INGEST_SECRET, and it is REQUIRED — an unauthenticated writer here
// would let anyone forge crawler traffic, and every conclusion on the GEO page is a count of these
// rows. Fabricating "OAI-SearchBot visited 400 times" is exactly the lie that would keep us from
// noticing we are blocked.
//
// If the secret is unset the route refuses rather than defaulting open. An analytics endpoint that
// silently accepts the world is worse than one that is switched off, because the data looks real.
//
// Accepts either a JSON array, {lines:[...]}, or NDJSON — because the three plausible senders each
// have their own idea of what a log batch looks like, and none of them will change for us.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = process.env.GEO_INGEST_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "GEO_INGEST_SECRET is not set, so log ingest is disabled." },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization");
  const key = req.nextUrl.searchParams.get("key");
  if (auth !== `Bearer ${secret}` && key !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const raw = await req.text();
  if (!raw.trim()) return NextResponse.json({ ok: true, received: 0, bot_hits: 0, referrals: 0, ignored: 0 });

  let lines: IngestLine[] = [];
  try {
    const parsed = JSON.parse(raw);
    lines = Array.isArray(parsed) ? parsed
      : Array.isArray((parsed as { lines?: unknown }).lines) ? (parsed as { lines: IngestLine[] }).lines
      : [parsed as IngestLine];
  } catch {
    // NDJSON — one JSON object per line, which is what Vercel and Cloudflare drains actually send.
    lines = raw.split("\n").map((l) => l.trim()).filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as IngestLine]; } catch { return []; }
    });
  }
  if (!lines.length) return NextResponse.json({ ok: false, error: "No parseable log lines." }, { status: 400 });

  // A hard cap so one malformed drain cannot insert a million rows in a single request.
  if (lines.length > 5000) lines = lines.slice(0, 5000);

  try {
    const r = await ingestLines(lines);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "ingest failed" }, { status: 500 });
  }
}
