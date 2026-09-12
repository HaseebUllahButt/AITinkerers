import { NextRequest, NextResponse } from "next/server";
import { isAuthorized, identifyCaller, actorFor } from "@/lib/auth/service";
import { ensureBacklinkCampaign, runBacklinkDiscovery, listBacklinkCampaigns } from "@/lib/backlinks/pipeline";
import { normalizeKeywords } from "@/lib/backlinks/targets";
import { runUrlAuthors } from "@/lib/backlinks/backlinkAuthors";
import { kickEnrichment } from "@/lib/backlinks/enrich";
import { closeIndexingBrowser } from "@/lib/indexing/fetchRendered";

export const maxDuration = 300;

// Auth lives in @/lib/auth/service so the agent and the crons are recognised by one rule. The
// local version this replaced returned true when CRON_SECRET was unset — a fail-open that the
// shared helper does not have.

// GET → list backlink campaigns with stage counts.
export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, campaigns: await listBacklinkCampaigns() });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "failed" }, { status: 500 });
  }
}

// POST { target, name?, keywords? } → create (or reuse) a backlink campaign for that page AND run
// discovery once. `name` lets several campaigns build links to the same page without mixing their
// data — identity is the name when given, the page otherwise. `keywords` are extra seed terms
// searched alongside the page's own topic, stored on the campaign so every later run uses them.
//
// What runs next is the caller's choice, not this route's:
//   articles: [...]  → read exactly those pages for their authors. Nothing is searched for.
//   discover: true   → search the web for pages worth pitching, as before.
//   neither          → create the campaign and stop.
// Picking a page used to be enough to start a web-wide scrape on its own topic, which is wrong
// whenever you already know the articles you want (an "alternatives" round, say) — the scrape
// spends credits on the wrong set and fills the funnel with prospects you then have to weed out.
export async function POST(req: NextRequest) {
  // identifyCaller rather than the boolean gate: a new campaign records who started it, which is
  // what lets the workspace answer "which of these are mine". Same allow-set as isAuthorized.
  const caller = await identifyCaller(req);
  if (!caller) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const target = typeof body.target === "string" && body.target.trim() ? body.target.trim() : null;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;
  // A page is no longer required. Plenty of rounds are about the brand rather than one money page
  // — an "alternatives" push is the example — and forcing a slug on those made people pick an
  // unrelated one, which then set the pitch's subject line and the verifier's target.
  //
  // A name is required in its place, and not as a formality: without a page, identity would fall
  // back to the site root, and every unnamed campaign would resolve to the same row.
  if (!target && !name) {
    return NextResponse.json(
      { ok: false, error: "Give the campaign a name, or pick the page you want links to." },
      { status: 400 },
    );
  }
  try {
    const keywords = normalizeKeywords(body.keywords);
    // "/" is the site itself. The pitch then asks for a link to northwind.example rather than to one
    // page, which is what a brand-level round wants anyway.
    const bl = await ensureBacklinkCampaign(target ?? "/", {
      name: name ?? undefined,
      createdBy: actorFor(caller),
      keywords,
    });

    // A supplied list wins over searching: you already did the picking, so the only work left is
    // reading each page for its author. Accepts an array or one pasted blob, same as the
    // "Add from backlinks" dialog, so both entry points parse a pasted column identically.
    const articles = Array.isArray(body.articles) ? body.articles.map(String)
      : Array.isArray(body.articleUrls) ? body.articleUrls.map(String) : undefined;
    const articlesText = typeof body.articles === "string" ? body.articles : undefined;
    const hasArticles = Boolean(articles?.length || articlesText?.trim());

    const urlAuthors = hasArticles
      ? await runUrlAuthors(bl, { urls: articles, text: articlesText })
      : null;

    // Keywords are passed to this run as well as stored, so a campaign created WITH keywords
    // searches on them immediately rather than only from its second press onward. Harmless when the
    // campaign already existed: the same list is merged and deduped either way.
    const discovery = body.discover === true
      ? await runBacklinkDiscovery(bl, { maxProspects: Number(body.maxProspects) || 15, keywords })
      : null;

    // Chain straight into email finding. Prospects without an address are silently skipped by
    // draftBacklinkPitches, so a campaign that stops at discovery is a campaign that never sends.
    // Skipped when nothing was added: there is nobody new to look up.
    const enrich = (discovery || urlAuthors?.saved) ? await kickEnrichment(bl.campaign_id) : null;
    return NextResponse.json({ ok: true, campaign: bl, discovery, urlAuthors, enrich });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "failed" }, { status: 500 });
  } finally {
    await closeIndexingBrowser().catch(() => {});
  }
}
