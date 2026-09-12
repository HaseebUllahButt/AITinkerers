import { NextRequest, NextResponse } from "next/server";
import { kickEnrichment } from "@/lib/backlinks/enrich";
import { isAuthorized } from "@/lib/auth/service";
import { supabaseAdmin } from "@/lib/db/supabase";
import { runBacklinkDiscovery, draftBacklinkPitches, verifyBacklinks, refileProspectArticles, type BacklinkCampaign } from "@/lib/backlinks/pipeline";
import { previewPitchAngle } from "@/lib/backlinks/pitchAngle";
import { closeIndexingBrowser } from "@/lib/indexing/fetchRendered";
import { runBacklinkAuthors, runUrlAuthors } from "@/lib/backlinks/backlinkAuthors";
import { runCompetitorAuthors } from "@/lib/backlinks/competitorAuthors";
import { normalizeKeywords } from "@/lib/backlinks/targets";

export const maxDuration = 300;

// Auth lives in @/lib/auth/service so a person, a cron and the agent are recognised by one
// rule. The local copy this replaced also returned true when CRON_SECRET was unset.

// POST { action: "enrich" | "draft" | "verify" | "discover" | "backlink-authors" | "url-authors"
//        | "competitor-authors" | "pitch-angle-preview" | "set-pitch-angle" | "set-pitch-mode"
//        | "set-keywords" }
// — advance one stage of the funnel, or add prospects from one of the three supply sources.
// enrich reuses the existing email-finder; draft writes pitches into outreach_emails (which the
// existing Sending page + cron then send); verify re-crawls prospects for a live link.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = String(body.action ?? "");

  // A database error is NOT "not found". During a DB saturation incident this lookup times out,
  // `data` comes back null, and conflating the two told a person staring at their own campaign
  // that it does not exist — after minutes of loading. Say what actually happened.
  const { data: bl, error: blError } = await supabaseAdmin.from("backlink_campaigns").select("*").eq("id", id).maybeSingle();
  if (blError) {
    return NextResponse.json(
      { ok: false, error: `The database did not answer (${blError.message}). Nothing was changed — try again in a minute.` },
      { status: 503 },
    );
  }
  if (!bl) return NextResponse.json({ ok: false, error: "No campaign with this id — it may have been deleted." }, { status: 404 });
  const campaign = bl as BacklinkCampaign;

  try {
    if (action === "discover") {
      // `keywords` is a per-run addition, not a setting: "also try these two this time". The
      // campaign's saved list (set-keywords below) is always used and does not need resending.
      const discovery = await runBacklinkDiscovery(campaign, {
        maxProspects: Number(body.maxProspects) || 15,
        keywords: normalizeKeywords(body.keywords),
      });
      // Newly found prospects need addresses before they are worth anything, so enrichment follows
      // automatically here too rather than waiting for someone to press a second button.
      const enrich = await kickEnrichment(campaign.campaign_id);
      return NextResponse.json({ ok: true, discovery, enrich });
    }
    // Persist the campaign's extra seed KEYWORDS, so every discovery run — button-pressed or
    // scheduled — searches on them and not just on whatever the target page's title says. An empty
    // list clears them (back to the page's own topic). Discovery is NOT run here: saving and
    // spending search credits are separate decisions, and the UI presses both when you ask it to.
    if (action === "set-keywords") {
      const keywords = normalizeKeywords(body.keywords);
      const { error } = await supabaseAdmin.from("backlink_campaigns")
        .update({ keywords: keywords.length ? keywords : null, updated_at: new Date().toISOString() })
        .eq("id", campaign.id);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, keywords });
    }
    // Between "here is a list of domains" and outreach. Prospects filed from a domain carry the
    // homepage as their article, which the relevance gate reads and correctly refuses; this finds a real
    // piece on each domain, stores its text and clears the stale off-topic verdict.
    if (action === "refile-articles") {
      return NextResponse.json({ ok: true, refile: await refileProspectArticles(campaign, { timeBudgetMs: 250_000 }) });
    }
    if (action === "draft") {
      // `mode` is a per-run override, not a setting: "pitch the site this time" without changing what
      // tonight's cron does. Persisting the choice is set-pitch-mode below.
      const mode = body.mode === "site" ? "site" as const : body.mode === "article" ? "article" as const : undefined;
      return NextResponse.json({ ok: true, draft: await draftBacklinkPitches(campaign, { mode }) });
    }
    // Draft ONE sample pitch in the asked-for angle against a real prospect, writing nothing.
    // The confirm step of the Pitch angle dialog: the person reads this before anything is saved.
    if (action === "pitch-angle-preview") {
      const instruction = String(body.instruction ?? "").trim();
      if (!instruction) return NextResponse.json({ ok: false, error: "Say how the pitches should be written first." }, { status: 400 });
      if (instruction.length > 2_000) return NextResponse.json({ ok: false, error: "That instruction is too long to apply." }, { status: 400 });
      const result = await previewPitchAngle(campaign, instruction);
      if (!result.ok) return NextResponse.json(result, { status: 422 });
      return NextResponse.json(result);
    }
    // Persist the campaign's pitch ANGLE, so every later initial draft — button-pressed or the
    // nightly cron — is written from it. Empty instruction clears it (back to the stock paid
    // angle). Existing pitches are not touched here: the dialog follows this with the
    // workflow-wide rewrite (/api/workflows/:id/revise-emails), which reports its own progress.
    if (action === "set-pitch-angle") {
      const raw = typeof body.instruction === "string" ? body.instruction.trim() : "";
      if (raw.length > 2_000) return NextResponse.json({ ok: false, error: "That instruction is too long to store." }, { status: 400 });
      const { error } = await supabaseAdmin.from("backlink_campaigns")
        .update({ pitch_angle: raw || null, updated_at: new Date().toISOString() }).eq("id", campaign.id);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, pitch_angle: raw || null });
    }
    // Persist how this campaign pitches, so the nightly run makes the same choice a person made here.
    if (action === "set-pitch-mode") {
      const mode = body.mode === "site" ? "site" : body.mode === "article" ? "article" : null;
      if (!mode) return NextResponse.json({ ok: false, error: "mode must be 'article' or 'site'." }, { status: 400 });
      const { error } = await supabaseAdmin.from("backlink_campaigns")
        .update({ pitch_mode: mode, updated_at: new Date().toISOString() }).eq("id", campaign.id);
      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, pitch_mode: mode });
    }
    if (action === "verify") {
      return NextResponse.json({ ok: true, verify: await verifyBacklinks(campaign) });
    }
    if (action === "enrich") {
      return NextResponse.json({ ok: true, enrich: await kickEnrichment(campaign.campaign_id) });
    }
    // Mine a competitor's backlink profile for the people who wrote the linking pages.
    //
    // The warmest of the three prospect sources: these pages have already published a link to a
    // direct competitor, so the behaviour we want is proven rather than inferred.
    //
    // Enrichment is kicked automatically for the same reason "discover" does it — an author with no
    // address is not yet a prospect, and making that a second button just means it gets forgotten.
    if (action === "backlink-authors") {
      const target = String(body.target ?? "").trim();
      if (!target) {
        return NextResponse.json({ ok: false, error: "Pass `target`: the competitor domain whose backlinks to mine." }, { status: 400 });
      }
      const report = await runBacklinkAuthors(campaign, {
        target,
        limit: Number(body.limit) || undefined,
        minDr: body.minDr != null ? Number(body.minDr) : undefined,
        maxDr: body.maxDr != null ? Number(body.maxDr) : undefined,
      });
      const enrich = report.saved ? await kickEnrichment(campaign.campaign_id) : null;
      return NextResponse.json({ ok: true, backlinkAuthors: report, enrich });
    }
    // Paste a curated list of backlink pages, get their authors as prospects.
    //
    // Distinct from "backlink-authors" above, which discovers the list itself via Ahrefs. The SEO
    // team already does that research in their own Ahrefs seat and picks the relevant sites, so this
    // takes the finished list and does only the last mile. No Ahrefs units, no editorial filter.
    if (action === "url-authors") {
      const report = await runUrlAuthors(campaign, {
        urls: Array.isArray(body.urls) ? body.urls.map(String) : undefined,
        text: typeof body.text === "string" ? body.text : undefined,
        note: typeof body.note === "string" ? body.note : undefined,
      });
      const enrich = report.saved ? await kickEnrichment(campaign.campaign_id) : null;
      return NextResponse.json({ ok: true, urlAuthors: report, enrich });
    }
    // Restores a path that existed for about four hours. It was wired up on 3 Aug and a merge
    // conflict resolution in PR #9 later that day dropped the block, leaving runCompetitorAuthors
    // in the codebase reachable from nothing at all.
    if (action === "competitor-authors") {
      const competitors = Array.isArray(body.competitors) ? body.competitors.map(String) : undefined;
      const report = await runCompetitorAuthors(campaign, {
        competitors,
        maxPerSite: body.maxPerSite != null && Number.isFinite(Number(body.maxPerSite)) ? Number(body.maxPerSite) : undefined,
      });
      const enrich = report.saved ? await kickEnrichment(campaign.campaign_id) : null;
      return NextResponse.json({ ok: true, competitorAuthors: report, enrich });
    }
    return NextResponse.json({ ok: false, error: `unknown action "${action}"` }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "failed" }, { status: 500 });
  } finally {
    await closeIndexingBrowser().catch(() => {});
  }
}
