import { supabaseAdmin } from "@/lib/db/supabase";
import { SEED_DOMAINS } from "@config/seeds";

// Aggregators / social / stores / infra — never a pitchable editorial publication.
const IGNORE_DOMAINS = new Set([
  "reddit.com", "twitter.com", "x.com", "facebook.com", "instagram.com", "tiktok.com",
  "youtube.com", "github.com", "google.com", "news.google.com", "bing.com", "linkedin.com",
  "medium.com", "substack.com", "amazon.com", "aws.amazon.com", "wikipedia.org", "t.co",
  "bit.ly", "tinyurl.com", "goo.gl", "ow.ly", "wp.com", "pinterest.com", "threads.net",
  "bsky.app", "bsky.social", "atproto.com", "open.spotify.com", "spotify.com", "overcast.fm",
  "pod.link", "apple.com", "podcasts.apple.com", "cloudflare.com", "akamai.net", "fastly.net",
  "arxiv.org", "crunchboard.com", "mailto:", "javascript:", "localhost",
]);
const SEED_SET = new Set(SEED_DOMAINS.map((d) => d.toLowerCase()));
// Free-mail hosts sometimes end up as an author's "domain" — never a publication.
const FREE_MAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com", "aol.com", "me.com", "live.com", "msn.com"]);

function normHost(host: string): string { return host.replace(/^www\./, "").toLowerCase(); }

// A domain is "low value" as a recurring RSS source if it's an aggregator/social/infra host,
// a non-editorial subdomain (app/login/cdn/…), or otherwise boilerplate. These are exactly
// the footer/nav links that used to pollute the learned list.
function isLowValueDomain(rawHost: string): boolean {
  const h = normHost(rawHost);
  if (IGNORE_DOMAINS.has(h) || FREE_MAIL.has(h) || h.length < 4 || !h.includes(".")) return true;
  if (/^(app|login|signin|account|accounts|community|forum|security|ecosystem|contact|cdn|static|assets|img|i|status|developer|developers|docs|support|help|store|shop|careers|jobs|api|auth|id)\./.test(rawHost)) return true;
  if (/(^|\.)(google|reddit|twitter|facebook|instagram|linkedin|youtube|tiktok|pinterest|spotify|apple|threads|bsky|substack|amazon|github|gitlab|figma|notion|slack|discord)\./.test(rawHost)) return true;
  // Personal blog-farm subdomains (one author each) — captured as authors already; not worth
  // adding as a whole-feed RSS source. Root-level pubs (e.g. generativeai.pub) still pass.
  if (/(^|\.)(medium|substack|wordpress|blogspot|tumblr|beehiiv|ghost|wixsite|weebly)\.[a-z.]+$/.test(rawHost)) return true;
  if (/website-files\.com$|\.cdn\.|cloudfront\.net$|\.gov$/.test(rawHost)) return true;
  return false;
}

function parseSubredditFromSnippet(snippet: string | null): { sub: string; pts: number } | null {
  if (!snippet) return null;
  const m = snippet.match(/^r\/(\w+)\s*•\s*(\d+)/);
  if (!m) return null;
  return { sub: m[1], pts: parseInt(m[2], 10) };
}

export async function runLearningPhase() {
  const results = { subredditsFound: 0, domainsFound: 0, promoted: 0 };

  // ── 1. Subreddit learning ────────────────────────────────────────────────────
  // Pull all reddit hits — snippets look like "r/MachineLearning • 42 pts"
  const { data: redditHits } = await supabaseAdmin
    .from("discovery_hits")
    .select("snippet, url")
    .eq("source", "reddit")
    .not("snippet", "is", null);

  const subScores = new Map<string, number>();
  const subCounts = new Map<string, number>();

  for (const hit of redditHits ?? []) {
    const parsed = parseSubredditFromSnippet(hit.snippet);
    if (!parsed) continue;
    subScores.set(parsed.sub, (subScores.get(parsed.sub) ?? 0) + parsed.pts);
    subCounts.set(parsed.sub, (subCounts.get(parsed.sub) ?? 0) + 1);
  }

  for (const [sub, score] of subScores) {
    // Upsert — increment times_seen each time we see it across runs
    const { data: existing } = await supabaseAdmin
      .from("learned_sources")
      .select("id, times_seen, score")
      .eq("type", "subreddit")
      .eq("value", sub)
      .maybeSingle();

    if (existing) {
      await supabaseAdmin.from("learned_sources").update({
        score: Math.max(existing.score, score),
        times_seen: existing.times_seen + 1,
        last_seen_at: new Date().toISOString(),
      }).eq("id", existing.id);
    } else {
      await supabaseAdmin.from("learned_sources").insert({
        type: "subreddit",
        value: sub,
        score,
        times_seen: 1,
      });
      results.subredditsFound++;
    }
  }

  // ── 2. Domain learning from DISCOVERED-AUTHOR publications ────────────────────
  // The strongest self-expansion signal: sites where we actually found real, pitchable
  // writers. Those are proven editorial sources worth mining in full every run. (The old
  // approach learned from arbitrary outbound links, which just surfaced footer/CDN/social
  // junk.) A domain that produced our authors → add it to the recurring RSS source set.
  const { data: authorRows } = await supabaseAdmin
    .from("authors")
    .select("id, primary_domain_id, domain:domains!primary_domain_id(host), contacts(type)")
    .not("primary_domain_id", "is", null);

  const domAuthors = new Map<string, { authors: number; withEmail: number }>();
  for (const a of authorRows ?? []) {
    const host = (a as any).domain?.host as string | undefined;
    if (!host || isLowValueDomain(host)) continue;
    const bare = normHost(host);
    if (SEED_SET.has(bare)) continue; // already curated — no need to learn it
    const hasEmail = ((a as any).contacts ?? []).some((c: any) => c.type === "mailto");
    const rec = domAuthors.get(bare) ?? { authors: 0, withEmail: 0 };
    rec.authors++; if (hasEmail) rec.withEmail++;
    domAuthors.set(bare, rec);
  }

  // Batch: one read of existing domain rows + a single chunked upsert (per-domain round-trips
  // would be hundreds of sequential queries and grow with the author count).
  const { data: existingDomains } = await supabaseAdmin
    .from("learned_sources").select("id, value, times_seen, promoted, rejected").eq("type", "domain");
  const existingMap = new Map((existingDomains ?? []).map((r: any) => [r.value as string, r]));
  const now = new Date().toISOString();
  const rows: any[] = [];
  for (const [domain, { authors, withEmail }] of domAuthors) {
    const ex = existingMap.get(domain);
    if (ex?.rejected) continue; // respect a manual reject
    const score = authors * 10 + withEmail * 5;
    // Auto-promote a source that has clearly produced real writers: 2+ authors, or at least
    // one with a real email (a genuine pitch target). Everything else is recorded for review.
    const promote = authors >= 2 || withEmail >= 1;
    if (ex) {
      rows.push({ id: ex.id, type: "domain", value: domain, score, times_seen: ex.times_seen + 1, promoted: ex.promoted || promote, last_seen_at: now });
    } else {
      rows.push({ type: "domain", value: domain, score, times_seen: 1, promoted: promote, last_seen_at: now });
      results.domainsFound++;
      if (promote) results.promoted++;
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    await supabaseAdmin.from("learned_sources").upsert(rows.slice(i, i + 500), { onConflict: "type,value" });
  }

  // ── 3. Auto-promote: all new subreddits immediately ──────────────────────────
  const { data: subredditsToPromote } = await supabaseAdmin
    .from("learned_sources")
    .select("*")
    .eq("type", "subreddit")
    .eq("promoted", false)
    .eq("rejected", false);

  if (subredditsToPromote?.length) {
    // Get current reddit harvester config
    const { data: redditHarvester } = await supabaseAdmin
      .from("harvester_config")
      .select("id, config")
      .eq("name", "reddit")
      .maybeSingle();

    if (redditHarvester) {
      const existing = (redditHarvester.config?.subreddits as string[] | undefined) ?? [];
      const toAdd = subredditsToPromote
        .map((r) => r.value as string)
        .filter((s) => !existing.includes(s));

      if (toAdd.length > 0) {
        await supabaseAdmin.from("harvester_config").update({
          config: { ...redditHarvester.config, subreddits: [...existing, ...toAdd] },
        }).eq("id", redditHarvester.id);

        await supabaseAdmin.from("learned_sources")
          .update({ promoted: true })
          .in("value", toAdd)
          .eq("type", "subreddit");

        results.promoted += toAdd.length;
      }
    }
  }

  // Domains are promoted inline above (section 2) via learned_sources.promoted, which the
  // discovery pipeline reads directly (getPromotedLearnedDomains) and unions with SEED_DOMAINS
  // — no longer written into harvester_config, which used to REPLACE the curated seed list.
  return results;
}

// Promoted, non-rejected learned domains — the auto-grown half of the RSS source set. Filtered
// through isLowValueDomain again at read time so any legacy junk can't leak back in.
export async function getPromotedLearnedDomains(): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("learned_sources")
    .select("value")
    .eq("type", "domain").eq("promoted", true).eq("rejected", false);
  return [...new Set((data ?? []).map((r: any) => normHost(r.value as string)))].filter((d) => !isLowValueDomain(d));
}

export async function getLearnedSources() {
  const { data, error } = await supabaseAdmin
    .from("learned_sources")
    .select("*")
    .order("score", { ascending: false });
  if (error) throw error; // a failed read is not "nothing learned yet"
  return data ?? [];
}

export async function promoteLearnedSource(id: string) {
  const { data: source, error } = await supabaseAdmin
    .from("learned_sources")
    .select("*")
    .eq("id", id)
    .single();

  // Throw, don't return: the route reported {ok:true} for a promotion that never happened.
  if (error) throw error;
  if (!source) return;

  if (source.type === "subreddit") {
    const { data: rh } = await supabaseAdmin
      .from("harvester_config")
      .select("id, config")
      .eq("name", "reddit")
      .maybeSingle();

    if (rh) {
      const subs = (rh.config?.subreddits as string[] | undefined) ?? [];
      if (!subs.includes(source.value)) {
        await supabaseAdmin.from("harvester_config").update({
          config: { ...rh.config, subreddits: [...subs, source.value] },
        }).eq("id", rh.id);
      }
    }
  }

  // Domains need no config write — the pipeline reads promoted learned domains directly.
  await supabaseAdmin.from("learned_sources").update({ promoted: true, rejected: false }).eq("id", id);
}

export async function rejectLearnedSource(id: string) {
  await supabaseAdmin.from("learned_sources").update({ rejected: true, promoted: false }).eq("id", id);
}
