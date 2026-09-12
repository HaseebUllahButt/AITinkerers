import { supabaseAdmin } from "./supabase";

// Supabase REST API hard-caps at 1000 rows per request regardless of .limit().
// This helper paginates through any simple select query to get all rows.
export async function fetchAllRows<T>(
  table: string,
  select: string,
  apply?: (q: any) => any
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  let from = 0;
  while (true) {
    let q = supabaseAdmin.from(table).select(select).range(from, from + PAGE - 1);
    if (apply) q = apply(q);
    const { data, error } = await (q as any);
    // A read failure is NOT the end of the pages. The old `error || !data?.length` break made a
    // page-1 error look like an empty table and a mid-pagination error look like a smaller one —
    // silent truncation that flowed into prospect counts and the sourcing report as confident
    // partial numbers. Throwing turns it into an honest error at whatever surface called.
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...(data as T[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

import type {
  Author,
  Article,
  Contact,
  Domain,
  Score,
  Mention,
  SeedTool,
  HarvesterConfig,
  Suppression,
  PipelineRun,
  DiscoveryHit,
  ProspectCard,
  DashboardStats,
  Campaign,
  Workflow,
  WorkflowFilters,
  WorkflowProspect,
  EmailTemplate,
  LinkedinMessage,
  WhatsappMessage,
  WhatsappThreadMessage,
  OutreachEmail,
  EmailSendConfig,
} from "@/lib/types";
import { isLikelyPersonName, isGuessSource } from "@/lib/enrich/personFilter";
import { qualifyProspect, DR_MIN, RELEVANCE_MIN } from "@/lib/score/qualify";
import { registrableDomain } from "@/lib/util/domain";
import { isBlockedUrl } from "@/lib/util/url";
import { isRoleEmail } from "@/lib/email/roleEmail";
import { isPlaceholderEmail } from "@/lib/enrich/personFilter";

// ─── Domains ─────────────────────────────────────────────────────────────────

export async function upsertDomain(host: string, data: Partial<Domain> = {}): Promise<Domain> {
  const { data: domain, error } = await supabaseAdmin
    .from("domains")
    .upsert({ host, last_seen: new Date().toISOString(), ...data }, { onConflict: "host" })
    .select()
    .single();
  if (error) throw error;
  return domain;
}

export async function getDomains(): Promise<Domain[]> {
  const { data, error } = await supabaseAdmin
    .from("domains")
    .select("*")
    .order("dr_proxy_score", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// ─── Authors ─────────────────────────────────────────────────────────────────

export async function upsertAuthor(data: Partial<Author> & { full_name: string; primary_domain_id?: string }): Promise<Author> {
  const { data: author, error } = await supabaseAdmin
    .from("authors")
    .upsert(
      { ...data, updated_at: new Date().toISOString() },
      { onConflict: "full_name,primary_domain_id", ignoreDuplicates: false }
    )
    .select()
    .single();
  if (error) throw error;
  return author;
}

export async function getAuthors(opts?: { limit?: number; offset?: number }): Promise<Author[]> {
  const { data, error } = await supabaseAdmin
    .from("authors")
    .select("*, domain:domains(*)")
    .order("created_at", { ascending: false })
    .range(opts?.offset ?? 0, (opts?.offset ?? 0) + (opts?.limit ?? 50) - 1);
  if (error) throw error;
  return data ?? [];
}

// ─── Articles ────────────────────────────────────────────────────────────────

export async function upsertArticle(data: Partial<Article> & { url_canonical: string }): Promise<Article> {
  const { data: article, error } = await supabaseAdmin
    .from("articles")
    .upsert({ ...data, updated_at: new Date().toISOString() }, { onConflict: "url_canonical" })
    .select()
    .single();
  if (error) throw error;
  return article;
}

export async function linkArticleAuthor(articleId: string, authorId: string) {
  await supabaseAdmin
    .from("article_authors")
    .upsert({ article_id: articleId, author_id: authorId }, { onConflict: "article_id,author_id", ignoreDuplicates: true });
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export async function upsertContact(
  data: Partial<Contact> & { type: string; value: string },
  opts: { allowRole?: boolean } = {},
): Promise<Contact> {
  // Never store role/generic mailboxes (press@, pressinquiries@, info@, git@hf.co, …) from the
  // SCRAPE paths: they get scraped off sites and attached to many authors, so we'd email one org
  // inbox over and over. allowRole is the one sanctioned exception — a human deliberately picking
  // a shared inbox off the domain's address book (add_prospects_with_emails), where the address
  // attaches to exactly one editorial pseudo-author and the team's measured practice is that
  // contacto@/tips@ is how they get routed to the editor. The placeholder guard below has no
  // exception, deliberately: user@domain.com is not an address for anyone.
  if (data.type === "mailto" && isRoleEmail(data.value) && !opts.allowRole) {
    return { ...(data as any), id: "", skipped_role_email: true } as unknown as Contact;
  }
  // Documentation placeholders (user@domain.com, example@domain.com). Guarded at every extraction site
  // too, but this is the single choke point every write passes through — 13 of these reached the database
  // through a narrower check, stored at "sourced" trust, and were cleared to send. Never again from here.
  if (data.type === "mailto" && isPlaceholderEmail(data.value)) {
    return { ...(data as any), id: "", skipped_placeholder_email: true } as unknown as Contact;
  }
  const { data: contact, error } = await supabaseAdmin
    .from("contacts")
    .upsert(data, { onConflict: "author_id,type,value", ignoreDuplicates: true })
    .select()
    .single();
  if (error) throw error;
  return contact;
}

// Send-time safety net: has this exact recipient inbox ALREADY been sent an INITIAL from some
// OTHER thread? Many authors can share one address, and two workflows can each schedule the
// same person moments apart (the schedule-time contacted guard is a point-in-time snapshot), so
// we re-check at the moment of sending. Only sent INITIALS count (never our own follow-ups or
// negotiation replies, which legitimately reuse an already-emailed inbox within their thread),
// and test/redirected sends (recipient_override set) are ignored because they never actually
// reached this inbox.
export async function addressHasOtherSentInitial(recipientEmail: string, excludeId: string): Promise<boolean> {
  const clean = recipientEmail.replace(/^mailto:/i, "").trim().toLowerCase();
  if (!clean) return false;
  const { data, error } = await supabaseAdmin
    .from("outreach_emails")
    .select("id, author:authors!inner(contacts!inner(type, value))")
    .eq("status", "sent")
    .or("kind.eq.initial,kind.is.null")
    .is("recipient_override", null)
    .eq("author.contacts.type", "mailto")
    .ilike("author.contacts.value", `mailto:${clean}`)
    .neq("id", excludeId)
    .limit(1);
  if (error) throw error; // a duplicate-inbox guard that cannot read is not a pass
  return (data ?? []).length > 0;
}

// ─── Mentions ────────────────────────────────────────────────────────────────

export async function upsertMention(articleId: string, toolName: string, count = 1) {
  await supabaseAdmin
    .from("mentions")
    .upsert({ article_id: articleId, tool_name: toolName, count }, { onConflict: "article_id,tool_name" });
}

// ─── Discovery Hits ───────────────────────────────────────────────────────────

// Seed sources are URLs/sites the user explicitly chose for a campaign, so they bypass the
// video/social blocklist (e.g. a real bylined post on vimeo.com/blog): the user asked for
// that site's writers, so honor it. Everything else is still filtered.
const SEED_SOURCES = new Set(["seed_site", "seed_article"]);

export async function insertDiscoveryHit(hit: { url: string; source: string; query?: string; title?: string; snippet?: string }) {
  // Drop video/social/audio platforms (YouTube, TikTok, Reddit, X…) — we only profile
  // written articles & blog posts, so junk URLs never even enter the queue.
  if (isBlockedUrl(hit.url) && !SEED_SOURCES.has(hit.source)) return;
  // Explicitly whitelist columns — never spread unknown fields (e.g. camelCase from harvesters)
  const { error } = await supabaseAdmin.from("discovery_hits").upsert(
    {
      url: hit.url,
      source: hit.source,
      query: hit.query ?? null,
      title: hit.title ?? null,
      snippet: hit.snippet ?? null,
      discovered_at: new Date().toISOString(),
      processed: false,
    },
    { onConflict: "url,source", ignoreDuplicates: true }
  );
  if (error) console.error("[insertDiscoveryHit]", error.message, hit.url.slice(0, 60));
}

// Bulk insert discovery hits — chunked upserts instead of one round-trip per hit. Sequential
// single-row inserts run ~270ms each (Vercel↔Supabase latency), so 4000 hits would blow past
// the 300s function limit mid-save; bulk does the same in seconds. Returns rows attempted.
export async function insertDiscoveryHits(
  hits: Array<{ url: string; source: string; query?: string; title?: string; snippet?: string }>,
): Promise<number> {
  const now = new Date().toISOString();
  const rows = hits
    .filter((h) => h.url && (!isBlockedUrl(h.url) || SEED_SOURCES.has(h.source)))
    .map((h) => ({ url: h.url, source: h.source, query: h.query ?? null, title: h.title ?? null, snippet: h.snippet ?? null, discovered_at: now, processed: false }));
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabaseAdmin.from("discovery_hits").upsert(chunk, { onConflict: "url,source", ignoreDuplicates: true });
    if (error) { console.error("[insertDiscoveryHits]", error.message); continue; }
    n += chunk.length;
  }
  return n;
}

export async function getPendingHits(limit = 50): Promise<DiscoveryHit[]> {
  const { data, error } = await supabaseAdmin
    .from("discovery_hits")
    .select("*")
    .eq("processed", false)
    .order("discovered_at", { ascending: true })
    .limit(Math.min(limit, 1000)); // Supabase REST caps at 1000/request
  if (error) throw error;
  return data ?? [];
}

// Paginated version for large fetches — loops in 1000-row pages until maxTotal reached
export async function getAllPendingHits(maxTotal = 5000): Promise<DiscoveryHit[]> {
  const PAGE = 1000;
  const results: DiscoveryHit[] = [];
  let from = 0;

  while (results.length < maxTotal) {
    const to = from + PAGE - 1;
    const { data, error } = await supabaseAdmin
      .from("discovery_hits")
      .select("*")
      .eq("processed", false)
      .order("discovered_at", { ascending: true })
      .range(from, to);

    if (error) throw error;
    if (!data || data.length === 0) break;
    results.push(...data);
    if (data.length < PAGE) break; // last page
    from += PAGE;
  }

  return results.slice(0, maxTotal);
}

export async function markHitProcessed(id: string) {
  await supabaseAdmin.from("discovery_hits").update({ processed: true }).eq("id", id);
}

// URLs that already became an article (i.e. author/profiling is done).
export async function getProfiledUrlSet(): Promise<Set<string>> {
  const rows = await fetchAllRows<{ url_canonical: string }>("articles", "url_canonical");
  return new Set(rows.map((r) => r.url_canonical).filter(Boolean));
}

// Hits that have never been handled — NOT yet processed AND NOT already an article.
// Reprocess only touches these; anything already attempted (processed) or profiled is
// left alone so we never redo finished work.
export async function getUnprofiledHits(maxTotal = 5000): Promise<DiscoveryHit[]> {
  const profiled = await getProfiledUrlSet();
  const all = await fetchAllRows<DiscoveryHit>("discovery_hits", "*", (q) =>
    q.eq("processed", false).order("discovered_at", { ascending: true }));
  return all.filter((h) => !profiled.has(h.url)).slice(0, maxTotal);
}

export async function countUnprofiledHits(): Promise<{ total: number; handled: number; unprofiled: number }> {
  const profiled = await getProfiledUrlSet();
  const all = await fetchAllRows<{ url: string; processed: boolean }>("discovery_hits", "url, processed");
  const unprofiled = all.filter((h) => !h.processed && !profiled.has(h.url)).length;
  return { total: all.length, handled: all.length - unprofiled, unprofiled };
}

export async function countSavedHits(): Promise<{ total: number; pending: number }> {
  const [tot, pen] = await Promise.all([
    supabaseAdmin.from("discovery_hits").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("discovery_hits").select("id", { count: "exact", head: true }).eq("processed", false),
  ]);
  return { total: tot.count ?? 0, pending: pen.count ?? 0 };
}

export async function resetAllHitsForReprocess(source?: string) {
  // Supabase rejects bulk updates without a WHERE clause — must have at least one filter.
  // Use neq("id","") as a universal "match everything" filter when no source specified.
  let q = supabaseAdmin.from("discovery_hits").update({ processed: false });
  if (source) {
    q = q.eq("source", source);
  } else {
    q = (q as any).not("id", "is", null);
  }
  const { error } = await (q as any);
  if (error) console.error("[resetAllHitsForReprocess]", error.message);
}

export async function getAllHitsForReprocess(limit = 100, offset = 0): Promise<DiscoveryHit[]> {
  const { data } = await supabaseAdmin
    .from("discovery_hits")
    .select("*")
    .eq("processed", false)
    .order("discovered_at", { ascending: true })
    .range(offset, offset + limit - 1);
  return data ?? [];
}

// ─── Scores ──────────────────────────────────────────────────────────────────

export async function upsertScore(data: Partial<Score> & { author_id?: string; article_id?: string }): Promise<Score> {
  const { data: score, error } = await supabaseAdmin
    .from("scores")
    .upsert({ ...data, computed_at: new Date().toISOString() }, { onConflict: "author_id,article_id" })
    .select()
    .single();
  if (error) throw error;
  return score;
}

// ─── Content safety screening ──────────────────────────────────────────────────

export async function insertFlaggedContent(data: {
  author_id: string; article_id: string; category: string; severity: string; reason?: string;
}): Promise<void> {
  const { error } = await supabaseAdmin
    .from("flagged_content")
    .upsert(data, { onConflict: "article_id" });
  if (error) throw error;
}

export async function markArticleSafetyChecked(articleId: string): Promise<void> {
  await supabaseAdmin.from("articles").update({ safety_checked_at: new Date().toISOString() }).eq("id", articleId);
}

// Recomputes and stores an author's aggregate safety_score from all their flagged articles.
export async function recomputeAuthorSafetyScore(authorId: string): Promise<number> {
  const { computeSafetyScore, buildSafetySummary } = await import("@/lib/extract/safety");
  const { data: flags } = await supabaseAdmin
    .from("flagged_content")
    .select("category, severity, reason")
    .eq("author_id", authorId);
  const score = computeSafetyScore((flags ?? []) as any);
  const summary = buildSafetySummary(score, (flags ?? []) as any);
  await supabaseAdmin.from("authors").update({ safety_score: score, safety_summary: summary, safety_checked_at: new Date().toISOString() }).eq("id", authorId);
  return score;
}

// ─── Seeds ────────────────────────────────────────────────────────────────────

export async function getSeeds(): Promise<SeedTool[]> {
  const { data, error } = await supabaseAdmin.from("seed_tools").select("*").order("name");
  if (error) throw error;
  return data ?? [];
}

export async function upsertSeed(
  name: string,
  aliases: string[] = [],
  enabled = true,
  category: "our_product" | "competitor" | "topic" = "competitor"
) {
  await supabaseAdmin
    .from("seed_tools")
    .upsert({ name, aliases, enabled, category }, { onConflict: "name" });
}

export async function deleteSeed(id: string) {
  await supabaseAdmin.from("seed_tools").delete().eq("id", id);
}

// ─── Harvesters ──────────────────────────────────────────────────────────────

export async function getHarvesters(): Promise<HarvesterConfig[]> {
  const { data, error } = await supabaseAdmin.from("harvester_config").select("*").order("name");
  if (error) throw error;
  return data ?? [];
}

export async function updateHarvester(id: string, data: Partial<HarvesterConfig>) {
  await supabaseAdmin.from("harvester_config").update(data).eq("id", id);
}

// ─── Suppression ─────────────────────────────────────────────────────────────

export async function getSuppressions(): Promise<Suppression[]> {
  const { data, error } = await supabaseAdmin.from("suppression").select("*").order("added_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function addSuppression(type: Suppression["type"], value: string, reason?: string) {
  await supabaseAdmin
    .from("suppression")
    .upsert({ type, value, reason }, { onConflict: "value", ignoreDuplicates: true });
}

export async function deleteSuppression(id: string) {
  await supabaseAdmin.from("suppression").delete().eq("id", id);
}

// Throws on a read error: SEND paths must fail closed (compose catches and refuses to send),
// while sourcing paths deliberately keep their `.catch(() => false)` — creating a prospect is
// reversible, sending is not.
export async function isSuppressed(host: string, authorName?: string): Promise<boolean> {
  const checks = [host];
  if (authorName) checks.push(authorName);
  const { data, error } = await supabaseAdmin
    .from("suppression")
    .select("id")
    .in("value", checks)
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// ─── Pipeline Runs ────────────────────────────────────────────────────────────

export async function createPipelineRun(stage?: string): Promise<PipelineRun> {
  const { data, error } = await supabaseAdmin
    .from("pipeline_runs")
    .insert({ stage, status: "running", started_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function finishPipelineRun(id: string, status: "completed" | "failed", stats = {}, error?: string) {
  await supabaseAdmin
    .from("pipeline_runs")
    .update({ status, stats, error, finished_at: new Date().toISOString() })
    .eq("id", id);
}

export async function getPipelineRuns(limit = 20): Promise<PipelineRun[]> {
  // This destructured `err` (a key supabase never sets) instead of `error`, and the `as any`
  // suppressed the type error that would have caught it — so the check never existed at all.
  const { data, error } = await supabaseAdmin
    .from("pipeline_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as PipelineRun[];
}

// ─── Prospect Cards ───────────────────────────────────────────────────────────

export async function getProspects(opts: {
  limit?: number;
  offset?: number;
  minScore?: number;
  archetype?: string;
  tool?: string;
  hasContact?: boolean;
  emailStatus?: "any" | "has" | "verified" | "guessed" | "none";
  search?: string;
  sortBy?: "composite" | "freshness" | "authority" | "relevance";
  campaignId?: string;
  excludeDiscarded?: boolean;
  restrictIds?: string[];   // limit results to this author-id set (AND) — used by AI search
  excludeIds?: string[];    // drop these author ids from results (e.g. already-contacted)
  priorityIds?: string[];   // float these to the top (composite order preserved within) — strong AI-search matches
  minDr?: number;           // only authors whose primary domain has real DR >= this
  qualifiedOnly?: boolean;  // only authors that pass the free qualification filters (DR>=50 + relevant)
}): Promise<{ prospects: ProspectCard[]; total: number }> {
  const limit = opts.limit ?? 24;
  const offset = opts.offset ?? 0;
  const excludeSet = new Set(opts.excludeIds ?? []);
  const prioritySet = new Set(opts.priorityIds ?? []);

  // ─── Collect author ID sets from each active filter ───────────────────────
  // Each filter produces a Set<string> of matching author IDs.
  // We intersect all sets at the end so every filter is AND-combined.
  const filterSets: Set<string>[] = [];

  // Always exclude non-person "authors" (publication names, "Staff", labels, bio blurbs
  // that discovery mis-extracted). Keeps the prospect list to real people.
  {
    const rows = await fetchAllRows<{ id: string; full_name: string; discarded: boolean | null }>("authors", "id, full_name, discarded");
    filterSets.push(new Set(
      rows.filter((r) => isLikelyPersonName(r.full_name) && !(opts.excludeDiscarded && r.discarded)).map((r) => r.id)
    ));
  }

  // Campaign filter: only authors discovered for this campaign
  if (opts.campaignId) {
    const rows = await fetchAllRows<{ author_id: string }>(
      "campaign_authors",
      "author_id",
      (q) => q.eq("campaign_id", opts.campaignId)
    );
    if (!rows.length) return { prospects: [], total: 0 };
    filterSets.push(new Set(rows.map((r) => r.author_id)));
  }

  // Search filter
  if (opts.search) {
    const rows = await fetchAllRows<{ id: string }>("authors", "id", (q) =>
      q.or(`full_name.ilike.%${opts.search}%,bio.ilike.%${opts.search}%`)
    );
    filterSets.push(new Set(rows.map((r) => r.id)));
  }

  // Restrict to an explicit author-id set (AI search hands in keyword-matched authors).
  if (opts.restrictIds) filterSets.push(new Set(opts.restrictIds));

  // Tool filter: authors who have an article that mentions this tool
  if (opts.tool && opts.tool !== "all") {
    const ments = await fetchAllRows<{ article_id: string }>("mentions", "article_id", (q) =>
      q.ilike("tool_name", `%${opts.tool}%`)
    );
    if (!ments.length) return { prospects: [], total: 0 };
    const articleIds = [...new Set(ments.map((m) => m.article_id))];
    // Chunk .in() calls to avoid URL length limits
    const aaRows: { author_id: string }[] = [];
    for (let i = 0; i < articleIds.length; i += 500) {
      const chunk = articleIds.slice(i, i + 500);
      const rows = await fetchAllRows<{ author_id: string }>("article_authors", "author_id", (q) =>
        q.in("article_id", chunk)
      );
      aaRows.push(...rows);
    }
    filterSets.push(new Set(aaRows.map((r) => r.author_id)));
  }

  // MinScore filter: authors with composite >= threshold
  if (opts.minScore && opts.minScore > 0) {
    const rows = await fetchAllRows<{ author_id: string }>("scores", "author_id", (q) =>
      q.gte("composite", opts.minScore)
    );
    filterSets.push(new Set(rows.map((r) => r.author_id)));
  }

  // Archetype filter: authors who wrote an article of this archetype
  if (opts.archetype && opts.archetype !== "all") {
    const arts = await fetchAllRows<{ id: string }>("articles", "id", (q) =>
      q.eq("archetype", opts.archetype)
    );
    if (!arts.length) return { prospects: [], total: 0 };
    const aaRows: { author_id: string }[] = [];
    for (let i = 0; i < arts.length; i += 500) {
      const chunk = arts.slice(i, i + 500).map((a) => a.id);
      const rows = await fetchAllRows<{ author_id: string }>("article_authors", "author_id", (q) =>
        q.in("article_id", chunk)
      );
      aaRows.push(...rows);
    }
    filterSets.push(new Set(aaRows.map((r) => r.author_id)));
  }

  // HasContact filter
  if (opts.hasContact) {
    const rows = await fetchAllRows<{ author_id: string }>("contacts", "author_id", (q) =>
      q.not("author_id", "is", null)
    );
    filterSets.push(new Set(rows.map((r) => r.author_id)));
  }

  // Email-status filter: has / verified (sourced) / guessed (pattern) / none
  if (opts.emailStatus && opts.emailStatus !== "any") {
    const mailto = await fetchAllRows<{ author_id: string; source: string | null }>("contacts", "author_id, source", (q) => q.eq("type", "mailto"));
    const hasEmail = new Set(mailto.map((r) => r.author_id));
    if (opts.emailStatus === "has") filterSets.push(hasEmail);
    else if (opts.emailStatus === "guessed") filterSets.push(new Set(mailto.filter((r) => isGuessSource(r.source)).map((r) => r.author_id)));
    else if (opts.emailStatus === "verified") filterSets.push(new Set(mailto.filter((r) => !isGuessSource(r.source)).map((r) => r.author_id)));
    else if (opts.emailStatus === "none") {
      const allAuthors = await fetchAllRows<{ id: string }>("authors", "id");
      filterSets.push(new Set(allAuthors.map((r) => r.id).filter((id) => !hasEmail.has(id))));
    }
    else if (opts.emailStatus === "linkedin_no_email") {
      const li = await fetchAllRows<{ author_id: string }>("contacts", "author_id", (q) => q.eq("type", "linkedin"));
      filterSets.push(new Set(li.map((r) => r.author_id).filter((id) => !hasEmail.has(id))));
    }
  }

  // Qualification filter: DR gate (real Ahrefs DR on the author's primary domain) and, for
  // qualifiedOnly, the relevancy gate too. Traffic/US are unverified for now so they never
  // block here (matches qualifyProspect: unverified paid filters don't disqualify).
  if (opts.qualifiedOnly || opts.minDr != null) {
    const drMin = opts.minDr ?? DR_MIN;
    const doms = await fetchAllRows<{ id: string }>("domains", "id", (q) => q.gte("dr", drMin));
    const domIds = new Set(doms.map((d) => d.id));
    const authors = await fetchAllRows<{ id: string; primary_domain_id: string | null }>("authors", "id, primary_domain_id");
    filterSets.push(new Set(authors.filter((a) => a.primary_domain_id && domIds.has(a.primary_domain_id)).map((a) => a.id)));
    if (opts.qualifiedOnly) {
      // Relevancy pass = best relevance >= RELEVANCE_MIN OR >= 5 mention rows across the author's
      // articles — exactly what qualifyProspect uses for the per-card badge, so the two agree.
      const rel = await fetchAllRows<{ author_id: string }>("scores", "author_id", (q) => q.gte("relevance", RELEVANCE_MIN));
      const relevantSet = new Set(rel.map((r) => r.author_id));
      const mentionRows = await fetchAllRows<{ article_id: string }>("mentions", "article_id");
      const perArticle = new Map<string, number>();
      for (const m of mentionRows) perArticle.set(m.article_id, (perArticle.get(m.article_id) ?? 0) + 1);
      const aaRows = await fetchAllRows<{ author_id: string; article_id: string }>("article_authors", "author_id, article_id");
      const perAuthor = new Map<string, number>();
      for (const aa of aaRows) perAuthor.set(aa.author_id, (perAuthor.get(aa.author_id) ?? 0) + (perArticle.get(aa.article_id) ?? 0));
      for (const [id, n] of perAuthor) if (n >= 5) relevantSet.add(id);
      filterSets.push(relevantSet);
    }
  }

  // ─── Get score-sorted author order ────────────────────────────────────────
  const sortCol =
    opts.sortBy === "freshness" ? "freshness"
    : opts.sortBy === "authority" ? "authority"
    : opts.sortBy === "relevance" ? "relevance"
    : "composite";

  const scoreRows = await fetchAllRows<{ author_id: string }>("scores", "author_id", (q) =>
    q.order(sortCol, { ascending: false })
  );
  // Deduplicate while preserving order — each author can have multiple score rows (one per article)
  const seen = new Set<string>();
  const scoreSortedIds: string[] = [];
  for (const r of scoreRows) {
    if (!seen.has(r.author_id)) {
      seen.add(r.author_id);
      scoreSortedIds.push(r.author_id);
    }
  }

  // ─── Intersect all filter sets ────────────────────────────────────────────
  let validIdSet: Set<string> | null = null;
  if (filterSets.length > 0) {
    // Start from smallest for efficiency
    const sorted = [...filterSets].sort((a, b) => a.size - b.size);
    validIdSet = new Set(sorted[0]);
    for (let i = 1; i < sorted.length; i++) {
      for (const id of validIdSet) {
        if (!sorted[i].has(id)) validIdSet.delete(id);
      }
    }
    if (validIdSet.size === 0) return { prospects: [], total: 0 };
  }

  // ─── Build final ordered page of IDs ─────────────────────────────────────
  let pageAuthorIds: string[];
  let total: number;

  if (scoreSortedIds.length > 0) {
    // Authors with scores, in sort order, filtered to valid set
    const ordered = scoreSortedIds.filter(id => (validIdSet === null || validIdSet.has(id)) && !excludeSet.has(id));
    // Append any authors that have no score row at the end
    if (validIdSet !== null) {
      const withScore = new Set(scoreSortedIds);
      for (const id of validIdSet) {
        if (!withScore.has(id) && !excludeSet.has(id)) ordered.push(id);
      }
    }
    // Float priority ids to the top (composite order preserved within each group).
    const finalOrder = prioritySet.size ? [...ordered.filter((id) => prioritySet.has(id)), ...ordered.filter((id) => !prioritySet.has(id))] : ordered;
    total = finalOrder.length;
    pageAuthorIds = finalOrder.slice(offset, offset + limit);
  } else {
    // No scores yet — fall back to valid set or all authors
    let allValid = (validIdSet ? [...validIdSet] : []).filter((id) => !excludeSet.has(id));
    if (prioritySet.size) allValid = [...allValid.filter((id) => prioritySet.has(id)), ...allValid.filter((id) => !prioritySet.has(id))];
    total = allValid.length;
    pageAuthorIds = allValid.slice(offset, offset + limit);
  }

  if (pageAuthorIds.length === 0) return { prospects: [], total };

  // ─── Fetch full author data for this page ─────────────────────────────────
  // Chunk the id list — a single .in() with hundreds/thousands of ids (e.g. export uses
  // limit 2000) overflows PostgREST's URL length and 400s. 200 ids/request is safe.
  const SELECT = `*,
      domain:domains(*),
      article_authors!inner(
        article:articles(
          *,
          mentions(*),
          domain:domains(*)
        )
      ),
      contacts(*),
      scores(*)`;
  const data: any[] = [];
  for (let i = 0; i < pageAuthorIds.length; i += 200) {
    const { data: chunk, error } = await supabaseAdmin
      .from("authors").select(SELECT).in("id", pageAuthorIds.slice(i, i + 200));
    // Throw, never `return { prospects: [], total: 0 }`: that shape is indistinguishable from a
    // genuinely empty database, and it rendered "No prospects match" over thousands of real rows
    // whenever this read failed. A console.error helps nobody in serverless.
    if (error) throw error;
    if (chunk) data.push(...chunk);
  }

  // Re-sort results to match the requested order (IN query doesn't preserve order)
  const idOrder = new Map(pageAuthorIds.map((id, i) => [id, i]));
  const sortedData = (data ?? []).sort((a: any, b: any) =>
    (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999)
  );

  const prospects: ProspectCard[] = sortedData.map((author: any) => {
    const articles: Article[] = (author.article_authors ?? []).map((aa: any) => aa.article).filter(Boolean);
    const allMentions = articles.flatMap((a: any) => (a.mentions ?? []).map((m: any) => m.tool_name));
    const uniqueTools = [...new Set(allMentions)];
    // Pick the score row with the highest composite so the badge always shows the author's best
    const score = (author.scores ?? []).sort((a: any, b: any) => (b.composite ?? 0) - (a.composite ?? 0))[0] ?? null;

    const dom = author.domain ?? null;
    const mailtos = (author.contacts ?? []).filter((c: any) => c.type === "mailto");
    // Use the author's BEST relevance across all their score rows (not the max-composite row's),
    // so this matches the qualifiedOnly filter which admits an author on ANY row >= RELEVANCE_MIN.
    const maxRelevance = Math.max(0, ...(author.scores ?? []).map((s: any) => s.relevance ?? 0));
    const qualification = qualifyProspect({
      dr: dom?.dr ?? null,
      organicTraffic: dom?.organic_traffic ?? null,
      usTrafficShare: dom?.us_traffic_share ?? null,
      relevance: maxRelevance,
      mentionCount: allMentions.length,
      articleCount: articles.length,
      hasEmail: mailtos.length > 0,
      contactConfidence: Math.max(0, ...(author.contacts ?? []).map((c: any) => c.confidence ?? 0), 0),
      // Free corroboration of the DR claim (enrich/domainSignals.ts). All null on a domain whose
      // signals have not been fetched yet, which yields spamRisk "unknown" rather than a clean bill.
      registeredOn: dom?.registered_on ?? null,
      openPageRank: dom?.open_pagerank ?? null,
      trancoRank: dom?.tranco_rank ?? null,
      trancoChecked: dom?.tranco_checked === true,
    });

    return {
      author: { ...author, contacts: undefined, scores: undefined, article_authors: undefined },
      articles,
      contacts: author.contacts ?? [],
      mentions: uniqueTools,
      score,
      domain: dom,
      qualification,
    };
  });

  return { prospects, total };
}

// AI-driven prospect search: given keywords (extracted from a natural-language prompt), find
// authors across ALL campaigns whose articles / tool-mentions / name / publication match — then
// hand off to getProspects for scoring, email-status filtering, and card hydration. Only returns
// people with an email; toggles for including guessed emails and already-contacted people.
// Match author IDs by keyword across articles (title/body), tool mentions, author name/bio,
// and publication name. Returns the full candidate set plus the "strong" subset (wrote about
// it directly — title or tool mention) for ranking. Keywords are capped/sanitized for the
// PostgREST .or() grammar; pass ≤12 at a time (callers with more should chunk and union).
export async function matchAuthorIdsByKeywords(keywords: string[]): Promise<{ authorIds: string[]; strongIds: string[] }> {
  // Sanitize for PostgREST .or() (commas/parens/wildcards break the filter grammar).
  const kws = [...new Set(keywords.map((k) => k.replace(/[,()%_*]/g, " ").trim().toLowerCase()).filter((k) => k.length >= 2))].slice(0, 12);
  if (kws.length === 0) return { authorIds: [], strongIds: [] };

  const authorIds = new Set<string>();  // all candidates (any match)
  const strongIds = new Set<string>();  // wrote about it directly (tool mention or article TITLE) → rank first
  const authorsForArticles = async (articleIds: string[]): Promise<string[]> => {
    const uniq = [...new Set(articleIds)];
    const out: string[] = [];
    for (let i = 0; i < uniq.length; i += 400) {
      const rows = await fetchAllRows<{ author_id: string }>("article_authors", "author_id", (q) => q.in("article_id", uniq.slice(i, i + 400)));
      out.push(...rows.map((r) => r.author_id));
    }
    return out;
  };

  // 1a) STRONG: article TITLE mentions a keyword (they clearly wrote about it).
  const titleFilter = kws.map((k) => `title.ilike.%${k}%`).join(",");
  const titleArts = await fetchAllRows<{ id: string }>("articles", "id", (q) => q.or(titleFilter)).catch(() => []);
  for (const a of await authorsForArticles(titleArts.map((a) => a.id))) { authorIds.add(a); strongIds.add(a); }

  // 1b) WEAK: article excerpt / body text mentions a keyword.
  const bodyFilter = kws.flatMap((k) => [`excerpt.ilike.%${k}%`, `readability_text_excerpt.ilike.%${k}%`]).join(",");
  const bodyArts = await fetchAllRows<{ id: string }>("articles", "id", (q) => q.or(bodyFilter)).catch(() => []);
  for (const a of await authorsForArticles(bodyArts.map((a) => a.id))) authorIds.add(a);

  // 2) STRONG: tool mentions matching a keyword (e.g. "seedance", "midjourney").
  const mFilter = kws.map((k) => `tool_name.ilike.%${k}%`).join(",");
  const ments = await fetchAllRows<{ article_id: string }>("mentions", "article_id", (q) => q.or(mFilter)).catch(() => []);
  for (const a of await authorsForArticles(ments.map((m) => m.article_id))) { authorIds.add(a); strongIds.add(a); }

  // 3) WEAK: author name / bio.
  const auFilter = kws.flatMap((k) => [`full_name.ilike.%${k}%`, `bio.ilike.%${k}%`]).join(",");
  (await fetchAllRows<{ id: string }>("authors", "id", (q) => q.or(auFilter)).catch(() => [])).forEach((r) => authorIds.add(r.id));

  // 4) WEAK: publication name → its authors.
  const dFilter = kws.map((k) => `name.ilike.%${k}%`).join(",");
  const doms = await fetchAllRows<{ id: string }>("domains", "id", (q) => q.or(dFilter)).catch(() => []);
  for (let i = 0; i < doms.length; i += 400) {
    const rows = await fetchAllRows<{ id: string }>("authors", "id", (q) => q.in("primary_domain_id", doms.slice(i, i + 400).map((d) => d.id)));
    rows.forEach((r) => authorIds.add(r.id));
  }
  return { authorIds: [...authorIds], strongIds: [...strongIds] };
}

// Link a campaign to every author relevant to its keywords (title/body/mention/name/publication
// match). Chunks keywords so campaigns with dozens of keywords match on ALL of them, not just
// the first 12. Returns how many authors are now linked. Safe to re-run (idempotent upsert).
export async function linkCampaignAuthorsByKeywords(campaignId: string, keywords: string[]): Promise<number> {
  const all = new Set<string>();
  for (let i = 0; i < keywords.length; i += 10) {
    const { authorIds } = await matchAuthorIdsByKeywords(keywords.slice(i, i + 10));
    authorIds.forEach((id) => all.add(id));
  }
  if (all.size > 0) await linkAuthorsToCampaign(campaignId, [...all]);
  return all.size;
}

export async function aiProspectSearch(opts: {
  keywords: string[]; includeContacted?: boolean; includeGuessed?: boolean; limit?: number;
}): Promise<{ prospects: ProspectCard[]; total: number; matchedAuthors: number }> {
  const matched = await matchAuthorIdsByKeywords(opts.keywords);
  const authorIds = new Set<string>(matched.authorIds);
  const strongIds = new Set<string>(matched.strongIds);

  const matchedAuthors = authorIds.size;
  if (matchedAuthors === 0) return { prospects: [], total: 0, matchedAuthors: 0 };

  const excludeIds = opts.includeContacted ? [] : [...(await getContactedAuthorIds())];
  const { prospects, total } = await getProspects({
    restrictIds: [...authorIds],
    excludeIds,
    priorityIds: [...strongIds], // writers who actually covered the tool/topic float to the top
    emailStatus: opts.includeGuessed ? "has" : "verified", // always requires an email; guessed optional
    excludeDiscarded: true,
    sortBy: "composite",
    limit: opts.limit ?? 200,
  });
  return { prospects, total, matchedAuthors };
}

// ─── Dashboard Stats ─────────────────────────────────────────────────────────

export async function getDashboardStats(): Promise<DashboardStats> {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [authors, domains, contacts, newAuthors] = await Promise.all([
    supabaseAdmin.from("authors").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("domains").select("id", { count: "exact", head: true }),
    // Authors with at least one contact — NOT the number of contact rows. An author has several
    // contacts (email, LinkedIn, X), so counting rows put "463% contactable" on the front page.
    // The inner join filters to authors that have a contact and counts the author rows.
    supabaseAdmin.from("authors").select("id, contacts!inner(author_id)", { count: "exact", head: true }),
    supabaseAdmin.from("authors").select("id", { count: "exact", head: true }).gte("created_at", oneWeekAgo),
  ]);
  // "0 prospects, 0% contactable" on the front page must mean the tables are empty, not that a
  // count failed. The `?? 0` below only smooths a null count on SUCCESS.
  for (const r of [authors, domains, contacts, newAuthors]) if (r.error) throw r.error;

  const totalAuthors = authors.count ?? 0;
  const totalPublications = domains.count ?? 0;
  const contactable = contacts.count ?? 0;

  return {
    totalProspects: totalAuthors,
    totalAuthors,
    totalPublications,
    contactablePercent: totalAuthors > 0 ? Math.round((contactable / totalAuthors) * 100) : 0,
    newThisWeek: newAuthors.count ?? 0,
  };
}

export async function getToolMentionCounts(): Promise<{ tool: string; count: number }[]> {
  const { data, error } = await supabaseAdmin
    .from("mentions")
    .select("tool_name")
    .then(({ data, error }) => {
      if (error) return { data: null, error };
      const counts: Record<string, number> = {};
      for (const row of data ?? []) {
        counts[row.tool_name] = (counts[row.tool_name] ?? 0) + 1;
      }
      return {
        data: Object.entries(counts)
          .map(([tool, count]) => ({ tool, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20),
        error: null,
      };
    });
  return data ?? [];
}

export async function getFreshnessTimeline(): Promise<{ date: string; count: number }[]> {
  const { data } = await supabaseAdmin
    .from("articles")
    .select("published_at")
    .not("published_at", "is", null)
    .order("published_at", { ascending: true })
    .limit(500);

  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    const day = row.published_at!.slice(0, 10);
    counts[day] = (counts[day] ?? 0) + 1;
  }

  return Object.entries(counts)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-90);
}

export async function getSourceProvenance(): Promise<{ source: string; count: number }[]> {
  const { data } = await supabaseAdmin.from("discovery_hits").select("source").eq("processed", true);
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    counts[row.source] = (counts[row.source] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);
}

export async function getTopPublications(): Promise<{ name: string; host: string; count: number; avgScore: number }[]> {
  const { data } = await supabaseAdmin
    .from("domains")
    .select("name, host, authors(id, scores(composite))")
    .limit(20);

  return (data ?? [])
    .map((d: any) => {
      const authors = d.authors ?? [];
      const scores = authors.flatMap((a: any) => a.scores ?? []).map((s: any) => s.composite ?? 0);
      return {
        name: d.name ?? d.host,
        host: d.host,
        count: authors.length,
        avgScore: scores.length > 0 ? Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length) : 0,
      };
    })
    .filter((d: any) => d.count > 0)
    .sort((a: any, b: any) => b.count - a.count)
    .slice(0, 10);
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export async function getCampaigns(): Promise<Campaign[]> {
  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;

  // Enrich with author counts — ONE read for every campaign, not one per campaign.
  //
  // This used to be Promise.all over campaigns.map(), each doing an exact HEAD count filtered to a
  // single campaign_id. That fires N full count queries simultaneously, and an exact count in
  // Postgres is a scan: there is no shortcut for it. Measured in the Supabase logs as ~18 identical
  // HEAD /campaign_authors?campaign_id=eq.<...> inside the SAME SECOND, on a NANO instance with
  // shared CPU — CPU 97%, disk IO 99%, and 196 5xx responses in an hour. PostgREST then could not
  // get a connection and answered "Could not query the database for the schema cache", which
  // surfaced in the app as an unrelated-looking HTTP 504 on the DRAFTS page.
  //
  // Reading the campaign_id column once and tallying in JS is a single index-only scan. Four pages
  // fetch /api/campaigns on mount, so this is N×4 queries per page-load cycle removed.
  const campaigns = data ?? [];
  if (campaigns.length === 0) return [];

  const ids = campaigns.map((c) => c.id);
  const countMap = new Map<string, number>();
  // Paged deliberately: PostgREST caps rows per response (1000 by default), and a silent truncation
  // here would under-report author counts on the biggest campaigns — the ones most likely to be
  // looked at. Stops as soon as a short page comes back.
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data: links, error: linkErr } = await supabaseAdmin
      .from("campaign_authors")
      .select("campaign_id")
      .in("campaign_id", ids)
      // .order() is not decoration here — Postgres does NOT guarantee row order for LIMIT/OFFSET
      // without one. Without it, a row can legally land on a different page across two calls to this
      // loop, and linkAuthorsToCampaign is upserting into this exact table continuously as discovery
      // runs find authors. A row that shifts between page 1 and page 2 while this loop is running
      // gets skipped (under-count) or read twice (over-count) — silently, since nothing here would
      // error. Ordering by the unique (campaign_id, author_id) pair makes page boundaries stable
      // regardless of concurrent writes, and campaign_id is already indexed as half of that
      // uniqueness constraint, so this doesn't add a sort the query wasn't already positioned for.
      .order("campaign_id", { ascending: true })
      .order("author_id", { ascending: true })
      .range(from, from + PAGE - 1);
    // A failure mid-pagination is the one case worth being loud about. Breaking quietly would return
    // counts built from the pages that DID arrive — every campaign under-reported by an arbitrary
    // amount, presented as though it were exact. That is worse than a zero, because a zero looks
    // wrong and a plausible-but-low number does not. The list itself is still returned: a secondary
    // number must never take the page down with it.
    if (linkErr) {
      console.warn(
        "[campaigns] author counts are INCOMPLETE — campaign_authors page at offset %d failed (%s). " +
          "The numbers shown are lower than reality.",
        from,
        linkErr.message,
      );
      break;
    }
    const rows = links ?? [];
    for (const r of rows) {
      const key = (r as { campaign_id: string }).campaign_id;
      countMap.set(key, (countMap.get(key) ?? 0) + 1);
    }
    if (rows.length < PAGE) break;
  }
  return campaigns.map((c) => ({ ...c, author_count: countMap.get(c.id) ?? 0 }));
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const { data, error } = await supabaseAdmin
    .from("campaigns")
    .select("*")
    .eq("id", id)
    .single();
  if (error) return null;
  return data;
}

export async function createCampaign(data: { name: string; keywords: string[]; region?: string; target_hits?: number; seed_writer_name?: string; seed_article_url?: string; seed_domains?: string[]; seed_article_urls?: string[] }): Promise<Campaign> {
  const { data: campaign, error } = await supabaseAdmin
    .from("campaigns")
    .insert({ ...data, target_hits: data.target_hits ?? 2500, status: "draft" })
    .select()
    .single();
  if (error) throw error;
  return campaign;
}

export async function updateCampaign(id: string, data: Partial<Campaign>): Promise<void> {
  const { error } = await supabaseAdmin.from("campaigns").update(data).eq("id", id);
  if (error) throw error;
}

export async function getCampaignAuthorIds(campaignId: string): Promise<Set<string>> {
  const rows = await fetchAllRows<{ author_id: string }>(
    "campaign_authors",
    "author_id",
    (q) => q.eq("campaign_id", campaignId)
  );
  return new Set(rows.map((r) => r.author_id));
}

// Composite-score distribution for a candidate pool (a campaign's authors, or all) —
// so the workflow filter can show min/median/avg/max to guide the min-score threshold.
export async function getScoreStats(campaignId?: string): Promise<{ count: number; min: number; max: number; avg: number; median: number }> {
  const empty = { count: 0, min: 0, max: 0, avg: 0, median: 0 };
  let authorIds: Set<string> | null = null;
  if (campaignId) {
    authorIds = await getCampaignAuthorIds(campaignId);
    if (authorIds.size === 0) return empty;
  }
  const rows = await fetchAllRows<{ author_id: string; composite: number }>("scores", "author_id, composite");
  const byAuthor = new Map<string, number>(); // best composite per author
  for (const r of rows) {
    if (authorIds && !authorIds.has(r.author_id)) continue;
    const v = r.composite ?? 0;
    if (v > (byAuthor.get(r.author_id) ?? -1)) byAuthor.set(r.author_id, v);
  }
  const vals = [...byAuthor.values()].sort((a, b) => a - b);
  if (!vals.length) return empty;
  const sum = vals.reduce((s, v) => s + v, 0);
  return {
    count: vals.length,
    min: Math.round(vals[0]),
    max: Math.round(vals[vals.length - 1]),
    avg: Math.round(sum / vals.length),
    median: Math.round(vals[Math.floor(vals.length / 2)]),
  };
}

// Given a set of article URLs, return all author IDs linked to those articles.
// Used for campaign linking during reprocess, where processHit skips already-existing
// articles and so can't report their authors via its return value.
export async function getAuthorIdsForUrls(urls: string[]): Promise<string[]> {
  if (!urls.length) return [];

  // 1. URLs → article IDs
  const articleIds: string[] = [];
  for (let i = 0; i < urls.length; i += 300) {
    const chunk = urls.slice(i, i + 300);
    const rows = await fetchAllRows<{ id: string }>("articles", "id", (q) =>
      q.in("url_canonical", chunk)
    );
    articleIds.push(...rows.map((r) => r.id));
  }
  if (!articleIds.length) return [];

  // 2. article IDs → author IDs
  const authorIds = new Set<string>();
  for (let i = 0; i < articleIds.length; i += 300) {
    const chunk = articleIds.slice(i, i + 300);
    const rows = await fetchAllRows<{ author_id: string }>("article_authors", "author_id", (q) =>
      q.in("article_id", chunk)
    );
    for (const r of rows) authorIds.add(r.author_id);
  }

  return [...authorIds];
}

export async function linkAuthorsToCampaign(campaignId: string, authorIds: string[]): Promise<void> {
  if (!authorIds.length) return;
  const now = new Date().toISOString();
  const rows = authorIds.map((id) => ({ campaign_id: campaignId, author_id: id, discovered_at: now }));
  for (let i = 0; i < rows.length; i += 500) {
    await supabaseAdmin
      .from("campaign_authors")
      .upsert(rows.slice(i, i + 500), { onConflict: "campaign_id,author_id", ignoreDuplicates: true });
  }
}

// ─── Workflows ────────────────────────────────────────────────────────────────

export async function getWorkflows(campaignId?: string): Promise<Workflow[]> {
  let q = supabaseAdmin
    .from("workflows")
    .select("*, campaign:campaigns(id, name)")
    .order("created_at", { ascending: false });
  if (campaignId) q = q.eq("campaign_id", campaignId) as any;
  const { data, error } = await (q as any);
  if (error) throw error;
  return data ?? [];
}

export async function getWorkflow(id: string): Promise<Workflow | null> {
  const { data, error } = await supabaseAdmin
    .from("workflows")
    .select("*, campaign:campaigns(id, name)")
    .eq("id", id)
    .single();
  if (error) return null;
  return data;
}

export async function createWorkflow(data: { campaign_id?: string; name: string; filters?: WorkflowFilters }): Promise<Workflow> {
  const { data: workflow, error } = await supabaseAdmin
    .from("workflows")
    .insert({ ...data, filters: data.filters ?? {}, status: "draft" })
    .select("*, campaign:campaigns(id, name)")
    .single();
  if (error) throw error;
  return workflow;
}

export async function updateWorkflow(id: string, data: Partial<{ name: string; filters: WorkflowFilters; status: string; prospect_count: number }>): Promise<void> {
  const { error } = await supabaseAdmin.from("workflows").update(data).eq("id", id);
  if (error) throw error;
}

export async function saveWorkflowProspects(workflowId: string, prospects: { author_id: string; rank: number; included: boolean }[]): Promise<void> {
  // Clear existing prospects first
  await supabaseAdmin.from("workflow_prospects").delete().eq("workflow_id", workflowId);
  if (!prospects.length) return;
  const rows = prospects.map((p) => ({ workflow_id: workflowId, ...p }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabaseAdmin.from("workflow_prospects").insert(rows.slice(i, i + 500));
    if (error) throw error;
  }
}

// Add ONE author to a workflow (from the search-and-add box). Idempotent: re-adds as
// included if already present, else appends after the last-ranked prospect.
// Bulk-add many authors to a workflow (AI find → "add all"). Skips ones already present,
// re-includes any that were excluded, ranks the rest after the current max.
export async function addWorkflowProspects(workflowId: string, authorIds: string[]): Promise<number> {
  const ids = [...new Set(authorIds)];
  if (ids.length === 0) return 0;
  const { data: existing } = await supabaseAdmin
    .from("workflow_prospects").select("id, author_id").eq("workflow_id", workflowId).in("author_id", ids);
  const existingByAuthor = new Map((existing ?? []).map((r: any) => [r.author_id, r.id]));
  const reinclude = [...existingByAuthor.values()];
  if (reinclude.length) await supabaseAdmin.from("workflow_prospects").update({ included: true }).in("id", reinclude);
  const { data: maxRow } = await supabaseAdmin
    .from("workflow_prospects").select("rank").eq("workflow_id", workflowId).order("rank", { ascending: false }).limit(1).maybeSingle();
  let rank = (((maxRow as any)?.rank as number) ?? 0) + 1;
  const toInsert = ids.filter((a) => !existingByAuthor.has(a)).map((author_id) => ({ workflow_id: workflowId, author_id, included: true, rank: rank++ }));
  for (let i = 0; i < toInsert.length; i += 500) {
    await supabaseAdmin.from("workflow_prospects").insert(toInsert.slice(i, i + 500));
  }
  return toInsert.length;
}

// Remove ONE prospect from a workflow entirely (not just exclude).
export async function removeWorkflowProspect(workflowId: string, authorId: string): Promise<void> {
  await supabaseAdmin.from("workflow_prospects").delete().eq("workflow_id", workflowId).eq("author_id", authorId);
}

// Remove ALL prospects from a workflow.
export async function removeAllWorkflowProspects(workflowId: string): Promise<number> {
  const { data } = await supabaseAdmin.from("workflow_prospects").delete().eq("workflow_id", workflowId).select("id");
  return (data ?? []).length;
}

export async function addWorkflowProspect(workflowId: string, authorId: string): Promise<void> {
  const { data: existing } = await supabaseAdmin
    .from("workflow_prospects").select("id").eq("workflow_id", workflowId).eq("author_id", authorId).maybeSingle();
  if (existing) {
    await supabaseAdmin.from("workflow_prospects").update({ included: true }).eq("id", (existing as any).id);
    return;
  }
  const { data: maxRow } = await supabaseAdmin
    .from("workflow_prospects").select("rank").eq("workflow_id", workflowId).order("rank", { ascending: false }).limit(1).maybeSingle();
  const rank = (((maxRow as any)?.rank as number) ?? 0) + 1;
  await supabaseAdmin.from("workflow_prospects").insert({ workflow_id: workflowId, author_id: authorId, included: true, rank });
}

export async function getWorkflowProspects(
  workflowId: string,
  opts?: { offset?: number; limit?: number }
): Promise<{ prospects: WorkflowProspect[]; total: number }> {
  const limit = opts?.limit ?? 50;
  const offset = opts?.offset ?? 0;

  const { count } = await supabaseAdmin
    .from("workflow_prospects")
    .select("id", { count: "exact", head: true })
    .eq("workflow_id", workflowId);

  const { data, error } = await supabaseAdmin
    .from("workflow_prospects")
    .select(`
      *,
      author:authors(
        *,
        domain:domains(*),
        contacts(*),
        article_authors(article:articles(*, mentions(*), domain:domains(*))),
        scores(*)
      )
    `)
    .eq("workflow_id", workflowId)
    .order("rank", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  const prospects: WorkflowProspect[] = (data ?? []).map((row: any) => {
    const author = row.author ?? {};
    const articles = (author.article_authors ?? []).map((aa: any) => aa.article).filter(Boolean);
    const score = (author.scores ?? []).sort((a: any, b: any) => (b.composite ?? 0) - (a.composite ?? 0))[0] ?? null;
    return {
      id: row.id,
      workflow_id: row.workflow_id,
      author_id: row.author_id,
      included: row.included,
      rank: row.rank,
      created_at: row.created_at,
      author: { ...author, scores: undefined, article_authors: undefined },
      articles,
      contacts: author.contacts ?? [],
      score,
      domain: author.domain ?? null,
    };
  });

  return { prospects, total: count ?? 0 };
}

// Full detail for one author — profile + contacts + all their articles (newest first).
// Null means "no such author" and ONLY that: a read failure throws, because callers turn null
// into the confident sentence "No author with id X" (the Hermes prospect_detail tool verbatim).
export async function getAuthorDetail(authorId: string): Promise<any | null> {
  const { data, error } = await supabaseAdmin
    .from("authors")
    .select(`*, domain:domains(*), contacts(*), article_authors(article:articles(*, domain:domains(*), mentions(*))), scores(*), flagged_content(*, article:articles(title, url_canonical))`)
    .eq("id", authorId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const articles = ((data as any).article_authors ?? [])
    .map((aa: any) => aa.article).filter(Boolean)
    .sort((a: any, b: any) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  const flaggedContent = (data as any).flagged_content ?? [];
  const score = ((data as any).scores ?? []).sort((a: any, b: any) => (b.composite ?? 0) - (a.composite ?? 0))[0] ?? null;
  // ProspectCard.mentions is a string[] of tool names (deduped) — the drawer renders each as
  // a badge. Return names, not raw mention rows, or React throws on rendering an object.
  const mentions = [...new Set(
    articles.flatMap((a: any) => (a.mentions ?? []).map((m: any) => m.tool_name)).filter(Boolean)
  )];
  // Effective "contacted" state for the drawer's Emailed toggle. A failed read here must not
  // present as "never contacted" — that claim green-lights a duplicate send.
  const { data: outreach, error: outreachError } = await supabaseAdmin
    .from("outreach_emails").select("id").eq("author_id", authorId).in("status", ["sent", "scheduled"]).limit(1);
  if (outreachError) throw outreachError;
  const override = ((data as any).contacted_override ?? null) as boolean | null;
  const hasHistory = (outreach ?? []).length > 0;
  const contacted = override === true ? true : override === false ? false : hasHistory;
  return {
    author: { ...(data as any), article_authors: undefined, scores: undefined, flagged_content: undefined },
    domain: (data as any).domain ?? null,
    contacts: (data as any).contacts ?? [],
    articles,
    mentions,
    score,
    flaggedContent,
    contacted,
    contactedOverride: override,
    hasOutreachHistory: hasHistory,
  };
}

export async function toggleWorkflowProspect(workflowId: string, authorId: string, included: boolean): Promise<void> {
  const { error } = await supabaseAdmin
    .from("workflow_prospects")
    .update({ included })
    .eq("workflow_id", workflowId)
    .eq("author_id", authorId);
  if (error) throw error;
}

// Bulk set included for many (or all) prospects in a workflow in ONE request — used by
// Select all / Deselect all so it doesn't fire a PATCH per prospect.
export async function setWorkflowProspectsIncluded(
  workflowId: string, included: boolean, authorIds?: string[],
): Promise<void> {
  let q = supabaseAdmin.from("workflow_prospects").update({ included }).eq("workflow_id", workflowId);
  if (authorIds && authorIds.length) q = q.in("author_id", authorIds) as any;
  const { error } = await q;
  if (error) throw error;
}

// Run workflow filters against campaign authors (or all authors if no campaign)
export async function runWorkflowFilters(
  filters: WorkflowFilters,
  campaignId?: string
): Promise<{ author_id: string; rank: number }[]> {
  // Start with the candidate pool
  let candidateIds: Set<string> | null = null;

  if (campaignId) {
    candidateIds = await getCampaignAuthorIds(campaignId);
    if (candidateIds.size === 0) return [];
  }

  const filterSets: Set<string>[] = [];

  if (candidateIds) filterSets.push(candidateIds);

  if (filters.minScore && filters.minScore > 0) {
    const rows = await fetchAllRows<{ author_id: string }>("scores", "author_id", (q) =>
      q.gte("composite", filters.minScore)
    );
    filterSets.push(new Set(rows.map((r) => r.author_id)));
  }

  if (filters.tool && filters.tool !== "all") {
    const ments = await fetchAllRows<{ article_id: string }>("mentions", "article_id", (q) =>
      q.ilike("tool_name", `%${filters.tool}%`)
    );
    if (!ments.length) return [];
    const articleIds = [...new Set(ments.map((m) => m.article_id))];
    const aaRows: { author_id: string }[] = [];
    for (let i = 0; i < articleIds.length; i += 500) {
      const rows = await fetchAllRows<{ author_id: string }>("article_authors", "author_id", (q) =>
        q.in("article_id", articleIds.slice(i, i + 500))
      );
      aaRows.push(...rows);
    }
    filterSets.push(new Set(aaRows.map((r) => r.author_id)));
  }

  if (filters.archetype && filters.archetype !== "all") {
    const arts = await fetchAllRows<{ id: string }>("articles", "id", (q) =>
      q.eq("archetype", filters.archetype)
    );
    if (!arts.length) return [];
    const aaRows: { author_id: string }[] = [];
    for (let i = 0; i < arts.length; i += 500) {
      const rows = await fetchAllRows<{ author_id: string }>("article_authors", "author_id", (q) =>
        q.in("article_id", arts.slice(i, i + 500).map((a) => a.id))
      );
      aaRows.push(...rows);
    }
    filterSets.push(new Set(aaRows.map((r) => r.author_id)));
  }

  if (filters.hasContact) {
    // "Has email" means specifically an email contact — NOT any social handle.
    const rows = await fetchAllRows<{ author_id: string }>("contacts", "author_id", (q) =>
      q.eq("type", "mailto")
    );
    filterSets.push(new Set(rows.map((r) => r.author_id)));
  }

  // Email-status filter: has / verified (sourced) / guessed (pattern) / none / linkedin-no-email
  if (filters.emailStatus && filters.emailStatus !== "any") {
    const mailto = await fetchAllRows<{ author_id: string; source: string | null }>("contacts", "author_id, source", (q) => q.eq("type", "mailto"));
    const hasEmail = new Set(mailto.map((r) => r.author_id));
    if (filters.emailStatus === "has") filterSets.push(hasEmail);
    else if (filters.emailStatus === "guessed") filterSets.push(new Set(mailto.filter((r) => isGuessSource(r.source)).map((r) => r.author_id)));
    else if (filters.emailStatus === "verified") filterSets.push(new Set(mailto.filter((r) => !isGuessSource(r.source)).map((r) => r.author_id)));
    else if (filters.emailStatus === "none") {
      const allAuthors = await fetchAllRows<{ id: string }>("authors", "id");
      filterSets.push(new Set(allAuthors.map((r) => r.id).filter((id) => !hasEmail.has(id))));
    }
    else if (filters.emailStatus === "linkedin_no_email") {
      // Has a LinkedIn contact but no email yet — the sweet spot for the email finder (Blitz
      // can turn a LinkedIn into an email).
      const li = await fetchAllRows<{ author_id: string }>("contacts", "author_id", (q) => q.eq("type", "linkedin"));
      filterSets.push(new Set(li.map((r) => r.author_id).filter((id) => !hasEmail.has(id))));
    }
  }

  // "Only not-yet-emailed" — exclude anyone already sent/queued (any workflow) or manually
  // marked contacted; honors "email again" overrides via getContactedAuthorIds.
  if (filters.notContacted) {
    const contacted = await getContactedAuthorIds();
    const allAuthors = await fetchAllRows<{ id: string }>("authors", "id");
    filterSets.push(new Set(allAuthors.map((r) => r.id).filter((id) => !contacted.has(id))));
  }

  if (filters.region) {
    const rows = await fetchAllRows<{ id: string }>("domains", "id", (q) =>
      q.ilike("country", `%${filters.region}%`)
    );
    const domainIds = rows.map((r) => r.id);
    if (!domainIds.length) return [];
    const authorRows: { id: string }[] = [];
    for (let i = 0; i < domainIds.length; i += 500) {
      const chunk = await fetchAllRows<{ id: string }>("authors", "id", (q) =>
        q.in("primary_domain_id", domainIds.slice(i, i + 500))
      );
      authorRows.push(...chunk);
    }
    filterSets.push(new Set(authorRows.map((r) => r.id)));
  }

  // Intersect all filter sets
  let validIds: Set<string>;
  if (filterSets.length === 0) {
    // No filters — get all author IDs
    const all = await fetchAllRows<{ id: string }>("authors", "id");
    validIds = new Set(all.map((r) => r.id));
  } else {
    const sorted = [...filterSets].sort((a, b) => a.size - b.size);
    validIds = new Set(sorted[0]);
    for (let i = 1; i < sorted.length; i++) {
      for (const id of validIds) {
        if (!sorted[i].has(id)) validIds.delete(id);
      }
    }
  }

  // Always exclude discarded authors — they're hidden from every workflow.
  const discardedRows = await fetchAllRows<{ id: string }>("authors", "id", (q) => q.eq("discarded", true));
  for (const r of discardedRows) validIds.delete(r.id);

  if (validIds.size === 0) return [];

  // Get score-sorted order
  const scoreRows = await fetchAllRows<{ author_id: string; composite: number }>("scores", "author_id, composite", (q) =>
    q.order("composite", { ascending: (filters.sortDir ?? "desc") === "asc" })
  );
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const r of scoreRows) {
    if (validIds.has(r.author_id) && !seen.has(r.author_id)) {
      seen.add(r.author_id);
      ordered.push(r.author_id);
    }
  }
  // Append authors with no scores
  for (const id of validIds) {
    if (!seen.has(id)) ordered.push(id);
  }

  const limit = filters.limit ?? 200;
  return ordered.slice(0, limit).map((id, i) => ({ author_id: id, rank: i + 1 }));
}

// ─── Email Templates ──────────────────────────────────────────────────────────

export async function getEmailTemplates(): Promise<EmailTemplate[]> {
  const { data, error } = await supabaseAdmin
    .from("email_templates")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function getEmailTemplate(id: string): Promise<EmailTemplate | null> {
  const { data, error } = await supabaseAdmin.from("email_templates").select("*").eq("id", id).single();
  if (error) return null;
  return data;
}

export async function createEmailTemplate(data: { name: string; subject: string; body: string; guidance?: string; channel?: "email" | "linkedin" }): Promise<EmailTemplate> {
  const { data: tmpl, error } = await supabaseAdmin
    .from("email_templates")
    .insert({ ...data, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) throw error;
  return tmpl;
}

export async function updateEmailTemplate(id: string, data: { name?: string; subject?: string; body?: string; guidance?: string; channel?: "email" | "linkedin" }): Promise<void> {
  const { error } = await supabaseAdmin
    .from("email_templates")
    .update({ ...data, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteEmailTemplate(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("email_templates").delete().eq("id", id);
  if (error) throw error;
}

// ─── LinkedIn Messages (generated connection notes, copy-paste — never sent) ────

export async function getLinkedinMessages(workflowId: string): Promise<LinkedinMessage[]> {
  const { data, error } = await supabaseAdmin
    .from("linkedin_messages")
    .select("*")
    .eq("workflow_id", workflowId);
  if (error) throw error;
  return data ?? [];
}

// Overwrite the note for one prospect (upsert on workflow_id+author_id — same shape
// as outreach emails, so re-generating or hand-editing just replaces it).
export async function upsertLinkedinMessage(data: {
  workflow_id: string;
  author_id: string;
  template_id?: string | null;
  body: string;
}): Promise<void> {
  const { error } = await supabaseAdmin
    .from("linkedin_messages")
    .upsert({ ...data, updated_at: new Date().toISOString() }, { onConflict: "workflow_id,author_id" });
  if (error) throw error;
}

/** Record that a person actually DM'd the note (or undo a mis-click with sent=false). UPDATE, not
 *  upsert: a note that does not exist cannot have been sent. Throws if no row matched. */
export async function markLinkedinNoteSent(workflowId: string, authorId: string, sent: boolean, actor: string | null): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("linkedin_messages")
    .update(sent
      ? { sent_at: new Date().toISOString(), sent_by: actor, updated_at: new Date().toISOString() }
      : { sent_at: null, sent_by: null, updated_at: new Date().toISOString() })
    .eq("workflow_id", workflowId).eq("author_id", authorId)
    .select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No LinkedIn note exists for this prospect yet.");
}

// ─── WhatsApp Messages (generated first DMs, sent by a person via wa.me — never by us) ────

export async function getWhatsappMessages(workflowId: string): Promise<WhatsappMessage[]> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .select("*")
    .eq("workflow_id", workflowId);
  if (error) throw error;
  return data ?? [];
}

// Overwrite the message for one prospect (upsert on workflow_id+author_id, same shape as the
// LinkedIn notes — re-generating or hand-editing just replaces it).
export async function upsertWhatsappMessage(data: {
  workflow_id: string;
  author_id: string;
  template_id?: string | null;
  body: string;
}): Promise<void> {
  const { error } = await supabaseAdmin
    .from("whatsapp_messages")
    .upsert({ ...data, updated_at: new Date().toISOString() }, { onConflict: "workflow_id,author_id" });
  if (error) throw error;
}

/** Record that a person actually sent the WhatsApp DM (or undo a mis-click with sent=false).
 *  UPDATE, not upsert: a message that does not exist cannot have been sent. Throws if no row. */
export async function markWhatsappNoteSent(workflowId: string, authorId: string, sent: boolean, actor: string | null): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_messages")
    .update(sent
      ? { sent_at: new Date().toISOString(), sent_by: actor, updated_at: new Date().toISOString() }
      : { sent_at: null, sent_by: null, updated_at: new Date().toISOString() })
    .eq("workflow_id", workflowId).eq("author_id", authorId)
    .select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("No WhatsApp message exists for this prospect yet.");
}

// ─── WhatsApp vendor threads (085 — running negotiations, one row per message) ───────────

/** The whole conversation with one vendor, oldest first. Ordered by when the message actually
 *  happened (sent_at), falling back to when we logged it — a paste-in backfill carries real
 *  timestamps and must interleave correctly with rows logged live. */
export async function getWhatsappThread(authorId: string): Promise<WhatsappThreadMessage[]> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_thread_messages")
    .select("*")
    .eq("author_id", authorId)
    .order("sent_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) throw error; // a failed read is not an empty thread
  return data ?? [];
}

/** Batch insert (a composer send is a batch of one; a paste-in is many). Returns the stored rows
 *  so the UI can render exactly what the database holds, not what it hoped to write. */
export async function insertWhatsappThreadMessages(rows: Array<{
  author_id: string;
  workflow_id?: string | null;
  direction: "inbound" | "outbound";
  body: string;
  source: "composer" | "manual_paste" | "webhook" | "negotiator";
  status?: "sent" | "failed";
  wa_message_id?: string | null;
  error?: string | null;
  sent_at?: string | null;
  sent_by?: string | null;
}>): Promise<WhatsappThreadMessage[]> {
  if (rows.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("whatsapp_thread_messages")
    .insert(rows.map((r) => ({ status: "sent", ...r })))
    .select("*");
  if (error) throw error;
  return data ?? [];
}

/** Webhook ingest: insert unless WhatsApp already delivered this exact message (retries are
 *  normal). Returns the row when inserted, null when it was a duplicate. */
export async function insertWaInboundOnce(row: {
  author_id: string;
  body: string;
  wa_message_id: string;
  media_url?: string | null;
  media_type?: string | null;
  sent_at: string;
}): Promise<WhatsappThreadMessage | null> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_thread_messages")
    .upsert({ ...row, direction: "inbound", source: "webhook", status: "sent" }, { onConflict: "wa_message_id", ignoreDuplicates: true })
    .select("*").maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** Bridge ingest (WAHA): one row per mirrored message, either direction, deduped on the WhatsApp
 *  id. Unlike the Cloud path this also files OUR OWN outbound — a message the person types on their
 *  phone is echoed here so Summit's thread stays in sync with the real chat. Returns the row when
 *  inserted, null when it was a duplicate (WAHA redelivers; our own bridge-sends echo back). */
export async function insertWaBridgeMessageOnce(row: {
  author_id: string;
  direction: "inbound" | "outbound";
  body: string;
  wa_message_id: string;
  media_type?: string | null;
  sent_at: string;
  sent_by?: string | null;
}): Promise<WhatsappThreadMessage | null> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_thread_messages")
    .upsert({ ...row, source: "bridge", status: "sent" }, { onConflict: "wa_message_id", ignoreDuplicates: true })
    .select("*").maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** Park / clear the negotiator's read-only suggestion on the deal anchor (087). */
export async function setWaSuggestion(anchorId: string, text: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("outreach_emails")
    .update({ wa_suggested_reply: text, wa_suggested_at: new Date().toISOString() })
    .eq("id", anchorId);
  if (error) throw error;
}
export async function clearWaSuggestionForAuthor(authorId: string): Promise<void> {
  // Any outbound message supersedes a pending suggestion — clear by author so it doesn't matter
  // whether the send went through the composer, the negotiator, or the person's own phone.
  const { error } = await supabaseAdmin
    .from("outreach_emails")
    .update({ wa_suggested_reply: null, wa_suggested_at: null })
    .eq("author_id", authorId).eq("channel", "whatsapp").eq("kind", "initial")
    .not("wa_suggested_reply", "is", null);
  if (error) throw error;
}

/** Delivery receipts (delivered/read/failed) arrive by wa_message_id. Failed carries the reason. */
export async function updateWaMessageStatus(waMessageId: string, status: "delivered" | "read" | "failed", errorText?: string | null): Promise<void> {
  const { error } = await supabaseAdmin
    .from("whatsapp_thread_messages")
    .update({ status, ...(status === "failed" ? { error: errorText ?? "delivery failed" } : {}), updated_at: new Date().toISOString() })
    .eq("wa_message_id", waMessageId);
  if (error) throw error;
}

/** Meta requires recorded opt-in for business-initiated (template) sends. An inbound message IS
 *  the working consent for the running thread; this records it durably. Idempotent. */
export async function recordWaOptin(authorId: string, number: string, method: "inbound_message" | "manual", recordedBy: string | null): Promise<void> {
  const { error } = await supabaseAdmin
    .from("whatsapp_optins")
    .upsert({ author_id: authorId, number, method, recorded_by: recordedBy }, { onConflict: "author_id", ignoreDuplicates: true });
  if (error) throw error;
}

export async function hasWaOptin(authorId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_optins").select("author_id").eq("author_id", authorId).maybeSingle();
  if (error) throw error;
  return !!data;
}

/** Vendor lookup for the webhook: a wa.me contact matching these digits → author. Oldest contact
 *  wins, for the reason spelled out on findWaVendorAuthor — this is the call that decides which
 *  chat an incoming message lands in, so it must answer the same way every time. */
export async function findVendorByWaDigits(digits: string): Promise<{ author_id: string; name: string } | null> {
  const { data, error } = await supabaseAdmin
    .from("contacts")
    .select("author_id, author:authors(full_name)")
    .eq("type", "whatsapp").eq("value", `https://wa.me/${digits}`)
    .order("created_at", { ascending: true })
    .limit(1).maybeSingle();
  if (error) throw error;
  if (!data?.author_id) return null;
  return { author_id: data.author_id, name: (data as any).author?.full_name ?? "Unknown" };
}

/** Undo for a mis-logged message. Human-logged rows only — a webhook/bridge row is WhatsApp's
 *  record of what actually happened, and deleting it would make the thread lie. Author-scoped so
 *  a stale id from one thread can never delete out of another. */
export async function deleteWhatsappThreadMessage(id: string, authorId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_thread_messages")
    .delete()
    .eq("id", id)
    .eq("author_id", authorId)
    .in("source", ["composer", "manual_paste"])
    .select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("That message wasn't hand-logged, so it can't be unlogged.");
}

// ─── WhatsApp vendor ownership (094) ─────────────────────────────────────────
// One WhatsApp number serves the whole team, so everyone's vendors pile into one list. An owner
// per chat lets each person filter to theirs. It is a LABEL, never a permission: an assigned chat
// leaves everyone else's default view, but "All" still shows it and says whose it is. A vendor
// thread nobody can find is how a deal goes quiet.

/** The people a chat can be assigned to: everyone the tool knows as a colleague. Sourced from
 *  user_email_config because that is the only roster this app has — a row exists per team member
 *  who has ever been set up to send. The caller adds themselves if they are somehow missing, so a
 *  new starter can always claim their own chats. */
export async function getTeamMembers(): Promise<{ email: string; label: string }[]> {
  const { data, error } = await supabaseAdmin
    .from("user_email_config")
    .select("user_email, from_name, shared_sender_label");
  if (error) throw error; // an empty picker would read as "there is nobody to assign to"
  const rows = (data ?? []) as Array<{ user_email: string; from_name: string | null; shared_sender_label: string | null }>;
  return rows
    .map((r) => ({ email: r.user_email, label: r.from_name || r.shared_sender_label || r.user_email }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Claim a vendor chat for someone, or release it with a null email. Idempotent; re-assigning
 *  overwrites, because handing a vendor over is a normal thing to do. */
export async function setWhatsappVendorOwner(authorId: string, userEmail: string | null, assignedBy: string | null): Promise<void> {
  if (!userEmail) {
    const { error } = await supabaseAdmin.from("whatsapp_vendor_owners").delete().eq("author_id", authorId);
    if (error) throw error;
    return;
  }
  const { error } = await supabaseAdmin
    .from("whatsapp_vendor_owners")
    .upsert({ author_id: authorId, user_email: userEmail, assigned_by: assignedBy, assigned_at: new Date().toISOString() }, { onConflict: "author_id" });
  if (error) throw error;
}

/** The vendor rail of the inbox list: one InboxPerson-shaped row per author who has a WhatsApp
 *  thread. TEAM-VISIBLE by design, unlike the email inbox's per-mailbox privacy boundary: these
 *  conversations live on the team's own phones, not in a credentialed mailbox, and the tool's
 *  copy is a shared log. Read/dismiss state stays per-user via inbox_state (author-keyed), and
 *  ownership (094) rides along as a label the UI filters on — every row is still returned. */
export async function getWhatsappVendorList(userEmail: string): Promise<InboxPerson[]> {
  const { data, error } = await supabaseAdmin
    .from("whatsapp_thread_messages")
    .select("author_id, direction, body, sent_at, created_at, author:authors(full_name, avatar_url, domain:domains(name, host), contacts(type, value))")
    // NEWEST first. The window used to be the oldest 5000 rows, which is the same bug this list is
    // judged on: past that many messages every new one would fall outside the window, so no chat
    // could ever rise to the top again and every excerpt would freeze. Newest-first is the only
    // truncation that cannot hide new activity. The aggregation below takes an explicit max per
    // author, so it does not care which order the rows arrive in.
    // The remaining cost of the cap is that a long-dormant vendor eventually drops off the list;
    // at 138 rows today that is theoretical, and the fix when it stops being theoretical is a
    // grouped view (see migration 092 for the pattern), not a bigger number here.
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) throw error; // a failed read is not "no vendor threads"

  type Agg = { author: any; last: any; lastInboundAt: string | null; lastOutboundAt: string | null };
  const at = (r: any) => (r.sent_at ?? r.created_at ?? "") as string;
  const byAuthor = new Map<string, Agg>();
  for (const r of data ?? []) {
    const cur = byAuthor.get(r.author_id) ?? { author: r.author, last: r, lastInboundAt: null, lastOutboundAt: null };
    if (at(r) > at(cur.last)) cur.last = r; // strict, so a tie keeps the newest-first row we saw
    if (r.direction === "inbound" && (!cur.lastInboundAt || at(r) > cur.lastInboundAt)) cur.lastInboundAt = at(r);
    if (r.direction === "outbound" && (!cur.lastOutboundAt || at(r) > cur.lastOutboundAt)) cur.lastOutboundAt = at(r);
    byAuthor.set(r.author_id, cur);
  }

  const authorIds = [...byAuthor.keys()];
  const stateByAuthor = new Map<string, { last_seen_at: string | null; dismissed: boolean }>();
  const anchorByAuthor = new Map<string, { ai_managed: boolean; negotiation_status: string | null; success_at: string | null }>();
  const ownerByAuthor = new Map<string, string>();
  const labelByEmail = new Map<string, string>();
  // Which names a person has vouched for (095). The rail shows every name either way; this is
  // what the header uses to offer "confirm" and what keeps the negotiator from using the rest.
  let confirmedNames = new Set<string>();
  if (authorIds.length) {
    confirmedNames = await confirmedVendorNames(authorIds);
    const { data: own, error: ownError } = await supabaseAdmin
      .from("whatsapp_vendor_owners").select("author_id, user_email").in("author_id", authorIds);
    if (ownError) throw ownError; // else every claimed chat reappears in everyone's list as unowned
    for (const o of (own ?? []) as Array<{ author_id: string; user_email: string }>) {
      ownerByAuthor.set(o.author_id, o.user_email);
    }
    // Owner names, so a row can say "Arham" rather than an email address. A roster read that fails
    // costs the label, not the assignment — the filter works on the email either way.
    if (ownerByAuthor.size) {
      for (const m of await getTeamMembers().catch(() => [])) labelByEmail.set(m.email.toLowerCase(), m.label);
    }

    const { data: st, error: stError } = await supabaseAdmin
      .from("inbox_state").select("author_id, last_seen_at, dismissed").eq("user_email", userEmail).in("author_id", authorIds);
    if (stError) throw stError; // else every vendor thread renders unread
    for (const s of st ?? []) stateByAuthor.set(s.author_id, { last_seen_at: s.last_seen_at, dismissed: !!s.dismissed });
    // Deal state rides the WhatsApp anchor (kind='initial', channel='whatsapp') — the AI badge,
    // negotiation status and wins in the rail come from here, same fields as the email list.
    const { data: an, error: anError } = await supabaseAdmin
      .from("outreach_emails").select("author_id, ai_managed, negotiation_status, success_at")
      .eq("channel", "whatsapp").eq("kind", "initial").in("author_id", authorIds);
    if (anError) throw anError;
    for (const a of an ?? []) anchorByAuthor.set((a as any).author_id, { ai_managed: !!(a as any).ai_managed, negotiation_status: (a as any).negotiation_status ?? null, success_at: (a as any).success_at ?? null });
  }

  const out: InboxPerson[] = [];
  for (const [author_id, agg] of byAuthor) {
    const a: any = agg.author ?? {};
    const wa = (a.contacts ?? []).find((c: any) => c.type === "whatsapp");
    const state = stateByAuthor.get(author_id);
    // Unread/needs-reply hang off the vendor's latest message, mirroring the email list's
    // replied_at semantics: their words, not ours, are what demands attention.
    const unread = !!agg.lastInboundAt && (!state?.last_seen_at || agg.lastInboundAt > state.last_seen_at);
    const needs_reply = !!agg.lastInboundAt && (!agg.lastOutboundAt || agg.lastInboundAt > agg.lastOutboundAt);
    out.push({
      author_id, name: a.full_name ?? "Unknown", publication: a.domain?.name ?? a.domain?.host ?? "",
      avatar_url: a.avatar_url ?? null,
      recipient: wa ? String(wa.value).replace(/^https:\/\/wa\.me\//, "+") : "",
      sender_email: null,
      category: agg.lastInboundAt ? "replied" : "sent",
      last_at: at(agg.last) || null,
      replied_at: agg.lastInboundAt, bounced_at: null, reply_kind: null, reply_subject: null,
      reply_excerpt: (agg.last?.body ?? "").slice(0, 140) || null,
      reply_sentiment: null, reply_intent: null,
      success_at: anchorByAuthor.get(author_id)?.success_at ?? null, subject: "",
      unread, dismissed: !!state?.dismissed, needs_reply,
      ai_managed: anchorByAuthor.get(author_id)?.ai_managed ?? false,
      negotiation_status: anchorByAuthor.get(author_id)?.negotiation_status ?? null,
      channel: "whatsapp", whatsapp_url: wa ? String(wa.value) : null,
      assigned_to: ownerByAuthor.get(author_id) ?? null,
      assigned_label: ownerByAuthor.has(author_id)
        ? labelByEmail.get(ownerByAuthor.get(author_id)!.toLowerCase()) ?? ownerByAuthor.get(author_id)!
        : null,
      name_confirmed: confirmedNames.has(author_id),
    });
  }
  out.sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? ""));
  return out;
}

/** One vendor's header for the thread view: who they are and where the chat opens. Null means
 *  "no such author", which the route turns into a 404 — never an empty thread. */
export async function getWhatsappVendor(authorId: string): Promise<WaVendor | null> {
  const { data, error } = await supabaseAdmin
    .from("authors")
    .select("id, full_name, avatar_url, contacts(type, value)")
    .eq("id", authorId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const wa = ((data as any).contacts ?? []).find((c: any) => c.type === "whatsapp");
  const { data: vouch, error: vouchError } = await supabaseAdmin
    .from("whatsapp_vendor_names").select("push_name").eq("author_id", authorId).maybeSingle();
  if (vouchError) throw vouchError; // a failed read must not read as "confirmed" — see 095
  return {
    author_id: data.id, name: (data as any).full_name ?? "Unknown",
    avatar_url: (data as any).avatar_url ?? null, whatsapp_url: wa ? String(wa.value) : null,
    // Unconfirmed means the name is WhatsApp's pushname, not something a person checked. It is
    // still what we show; it is not something we say to them (see addressableName).
    name_confirmed: !!vouch, push_name: vouch?.push_name ?? null,
  };
}

export interface WaVendor {
  author_id: string; name: string; avatar_url: string | null; whatsapp_url: string | null;
  /** A person on the team vouched for `name` (095). False = it came from their WhatsApp profile. */
  name_confirmed: boolean;
  /** What WhatsApp called them when we met them, kept across renames. */
  push_name: string | null;
}

// The one standing workflow every vendor deal anchors to. outreach_emails.workflow_id is NOT
// NULL and the whole funnel/negotiation state machine assumes a workflow, so vendor threads —
// which predate any campaign — get a house one instead of a schema change.
export const VENDORS_WORKFLOW_NAME = "WhatsApp Vendors";

export async function getOrCreateVendorsWorkflow(): Promise<string> {
  const pick = async () => {
    // Oldest wins, so if a webhook race ever minted two, every caller converges on one canonical
    // workflow instead of splitting anchors across both.
    const { data, error } = await supabaseAdmin
      .from("workflows").select("id").eq("name", VENDORS_WORKFLOW_NAME)
      .order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (error) throw error;
    return data?.id ?? null;
  };
  const existing = await pick();
  if (existing) return existing;
  const campaign = await createCampaign({ name: VENDORS_WORKFLOW_NAME, keywords: [] });
  await createWorkflow({ campaign_id: campaign.id, name: VENDORS_WORKFLOW_NAME });
  const id = await pick();
  if (!id) throw new Error("vendors workflow vanished after creation");
  return id;
}

/** The deal anchor for one vendor: the outreach_emails row (kind='initial', channel='whatsapp')
 *  that carries negotiation state so the funnel, negotiation page and payments machinery all keep
 *  working. `replied_at` is NEVER set on these — vendor replies live in whatsapp_thread_messages,
 *  and a replied_at here would feed the anchor into the EMAIL auto-negotiation loop. */
export async function getWaAnchor(authorId: string): Promise<any | null> {
  const { data, error } = await supabaseAdmin
    .from("outreach_emails")
    .select("id, workflow_id, author_id, ai_managed, negotiation_status, agreed_price, deal_currency, max_offer, negotiation_notes, intervention_type, intervention_ask, wa_suggested_reply, wa_suggested_at")
    .eq("author_id", authorId).eq("channel", "whatsapp").eq("kind", "initial")
    .limit(1).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function getOrCreateWaAnchor(authorId: string, vendorName: string): Promise<any> {
  const existing = await getWaAnchor(authorId);
  if (existing) return existing;
  const workflowId = await getOrCreateVendorsWorkflow();
  const { error } = await supabaseAdmin.from("outreach_emails").insert({
    workflow_id: workflowId, author_id: authorId, kind: "initial", channel: "whatsapp",
    status: "draft", subject: `WhatsApp · ${vendorName}`, ai_managed: true,
    negotiation_status: "negotiating",
  });
  // A webhook race can double-insert; the partial unique index (workflow, author, kind) rejects
  // the second, and re-reading returns the winner either way.
  if (error && !/duplicate|unique/i.test(error.message)) throw error;
  const anchor = await getWaAnchor(authorId);
  if (!anchor) throw new Error("anchor vanished after creation");
  return anchor;
}

/** The author who owns this wa.me link, OLDEST contact row first.
 *
 *  The ordering is the point. An unordered `limit(1)` is free to answer differently between two
 *  calls, so once a number had two vendor rows it filed half a conversation under one author and
 *  half under the other — the chat the human had open then looked dead while their messages piled
 *  up in a twin. Oldest-wins is stable, and it is the same rule getOrCreateVendorsWorkflow uses
 *  and the same rule migration 093 merged on, so every path converges on one row. */
async function findWaVendorAuthor(waUrl: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("contacts").select("author_id").eq("type", "whatsapp").eq("value", waUrl)
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (error) throw error; // a failed dupe-check must not mint a second author for the number
  return data?.author_id ?? null;
}

/** Register a vendor the team already talks to on WhatsApp: an author row + a canonical wa.me
 *  contact. Re-adding an existing number returns the existing vendor instead of forking the
 *  thread across two author rows.
 *
 *  The check-then-insert below cannot do that on its own, and production proved it: a vendor
 *  sending three messages in one second arrives as three CONCURRENT bridge deliveries, all three
 *  read "no such contact", and all three mint an author. Nine numbers ended up with two or three
 *  vendor rows each. What makes this safe is the partial unique index from migration 093
 *  (contacts.value WHERE type='whatsapp' AND source='manual'): the racing inserts now collide in
 *  the database, and the losers converge on the winner here instead of forking the chat.
 *
 *  `namedBy` is the person who supplied the name, and it is what separates a name we can use to
 *  someone's face from a string WhatsApp handed us (see confirmWhatsappVendorName). The bridge and
 *  the Cloud webhook pass null: their `name` is the sender's own pushname. */
export async function createWhatsappVendor(name: string, waUrl: string, namedBy?: string | null): Promise<{ author_id: string; existing: boolean }> {
  const already = await findWaVendorAuthor(waUrl);
  if (already) return { author_id: already, existing: true };

  const { data, error } = await supabaseAdmin
    .from("authors").insert({ full_name: name, source: "manual" }).select("id").single();
  if (error) throw error;
  try {
    await upsertContact({ author_id: data.id, type: "whatsapp", value: waUrl, confidence: 1, source: "manual", verified_syntax: true });
  } catch (e) {
    // Someone registered this number between our check and our insert. Their author is the one
    // every other caller resolves to, so hand back theirs and take the empty one we just made with
    // us — a vendor row with no contact is a chat nobody can ever open.
    const winner = await findWaVendorAuthor(waUrl);
    if (!winner) throw e; // not a race but a real write failure, which must never read as success
    await supabaseAdmin.from("authors").delete().eq("id", data.id);
    return { author_id: winner, existing: true };
  }
  // A name a person typed into the add-vendor form is vouched from birth. A failure to record
  // that costs the name its confirmation, not the vendor their row.
  if (namedBy) await confirmWhatsappVendorName(data.id, name, namedBy).catch(() => {});
  return { author_id: data.id, existing: false };
}

// ─── Vendor names: what WhatsApp calls them vs what they are called (095) ─────
// WhatsApp's pushname is a display string the account holder types into their own profile. It is
// often a persona or a business tagline — the table today holds "us marketing", "Seo Outreach
// specialist", "testing", and a Karachi backlink vendor whose profile reads "Katie Grose". Filing
// a chat under it is fine; ADDRESSING someone by it is how the negotiator came to answer a vendor
// the team knows as Ali Ahmed with "Hello Katie, hope you're doing well."
//
// So a name is usable to their face only once a person on our team says it is. A row in
// whatsapp_vendor_names is that statement. Nothing infers it, because the whole failure was
// software being confident about a name nobody checked.

/** Record that a person vouched for this vendor's name, keeping whatever WhatsApp called them
 *  first. Idempotent — re-confirming just re-stamps who and when. */
export async function confirmWhatsappVendorName(authorId: string, name: string, namedBy: string | null): Promise<void> {
  // Only fill push_name the first time: it is the name we MET them under, and a second rename
  // must not overwrite it with the first rename's output.
  const { data: prior, error: readError } = await supabaseAdmin
    .from("whatsapp_vendor_names").select("push_name").eq("author_id", authorId).maybeSingle();
  if (readError) throw readError;
  const { error } = await supabaseAdmin.from("whatsapp_vendor_names").upsert({
    author_id: authorId, named_by: namedBy, named_at: new Date().toISOString(),
    push_name: prior?.push_name ?? name,
  }, { onConflict: "author_id" });
  if (error) throw error;
}

/** Set the name the team knows a vendor by, and vouch for it in one move. Confirming the existing
 *  name (renaming it to itself) is a normal, meaningful action: it says "yes, that IS them".
 *
 *  Scoped to vendors on purpose. authors is shared with the discovery pipeline, where full_name is
 *  a scraped fact about a blogger; this endpoint must never be a back door for editing one. */
export async function renameWhatsappVendor(authorId: string, name: string, namedBy: string | null): Promise<{ name: string; push_name: string | null }> {
  const { data: vendor, error: vendorError } = await supabaseAdmin
    .from("contacts").select("author_id").eq("author_id", authorId).eq("type", "whatsapp").eq("source", "manual")
    .limit(1).maybeSingle();
  if (vendorError) throw vendorError;
  if (!vendor) throw new Error("That author isn't a WhatsApp vendor, so their name isn't editable here.");

  const { data: before, error: beforeError } = await supabaseAdmin
    .from("authors").select("full_name").eq("id", authorId).maybeSingle();
  if (beforeError) throw beforeError;

  // push_name first: if the update lands and this doesn't, we lose the name we met them under.
  await confirmWhatsappVendorName(authorId, before?.full_name ?? name, namedBy);
  const { error } = await supabaseAdmin.from("authors").update({ full_name: name }).eq("id", authorId);
  if (error) throw error;
  const { data: row } = await supabaseAdmin
    .from("whatsapp_vendor_names").select("push_name").eq("author_id", authorId).maybeSingle();
  return { name, push_name: row?.push_name ?? null };
}

/** Every WhatsApp vendor with the number to look them up by and how their current name was
 *  decided — the input to a phone-book name sync. `named_by` distinguishes a name someone typed
 *  in the UI (which a sync must never overwrite) from one the address book supplied. */
export async function listWhatsappVendorsForNameSync(): Promise<Array<{ author_id: string; name: string; wa_url: string; named_by: string | null; confirmed: boolean }>> {
  const { data, error } = await supabaseAdmin
    .from("contacts").select("author_id, value, author:authors(full_name)")
    .eq("type", "whatsapp").eq("source", "manual");
  if (error) throw error;
  // PostgREST types an embedded one-to-one as an array; unwrap rather than fight the generated type.
  const rows = (data ?? []) as unknown as Array<{ author_id: string; value: string; author: { full_name: string | null } | { full_name: string | null }[] | null }>;
  const nameOf = (a: (typeof rows)[number]["author"]) => (Array.isArray(a) ? a[0]?.full_name : a?.full_name) ?? "";
  const ids = [...new Set(rows.map((r) => r.author_id))];
  const vouch = new Map<string, string | null>();
  if (ids.length) {
    const { data: v, error: vError } = await supabaseAdmin
      .from("whatsapp_vendor_names").select("author_id, named_by").in("author_id", ids);
    if (vError) throw vError;
    for (const r of (v ?? []) as Array<{ author_id: string; named_by: string | null }>) vouch.set(r.author_id, r.named_by);
  }
  return rows.map((r) => ({
    author_id: r.author_id, name: nameOf(r.author), wa_url: r.value,
    named_by: vouch.get(r.author_id) ?? null, confirmed: vouch.has(r.author_id),
  }));
}

/** Which of these vendors has a name a person confirmed. Everyone else gets addressed without
 *  one. */
async function confirmedVendorNames(authorIds: string[]): Promise<Set<string>> {
  if (!authorIds.length) return new Set();
  const { data, error } = await supabaseAdmin
    .from("whatsapp_vendor_names").select("author_id").in("author_id", authorIds);
  if (error) throw error; // guessing "unconfirmed" is safe, but guessing "confirmed" is the bug
  return new Set(((data ?? []) as Array<{ author_id: string }>).map((r) => r.author_id));
}

// ─── Outreach Emails ──────────────────────────────────────────────────────────

export async function getWorkflowEmails(workflowId: string): Promise<OutreachEmail[]> {
  // Only INITIAL outreach — the Emails page composes/sends initials. Follow-ups and negotiation
  // replies (kind='followup'/'negotiation') live on the Sending/Negotiation pages; without this
  // filter a newer negotiation draft would shadow the initial per author and show "0 ready".
  const { data, error } = await supabaseAdmin
    .from("outreach_emails")
    .select("*, author:authors(id, full_name, avatar_url, primary_domain_id, domain:domains(name, host))")
    .eq("workflow_id", workflowId)
    .or("kind.eq.initial,kind.is.null")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// One outreach email with its resolved recipient (mailto) — for the per-email "Send now".
export async function getOutreachEmailWithRecipient(id: string): Promise<(OutreachEmail & { recipient?: string }) | null> {
  const { data, error } = await supabaseAdmin
    .from("outreach_emails")
    .select("*, author:authors(contacts(type, value))")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error; // "Send now" on a visible row must not answer "not found" on a failed read
  if (!data) return null;
  const mailto = ((data as any).author?.contacts ?? []).find((c: any) => c.type === "mailto");
  const ovr = (data as any).recipient_override;
  const recipient = (ovr && ovr.trim()) || (mailto ? (mailto.value as string).replace(/^mailto:/, "") : undefined);
  return { ...(data as any), recipient };
}

export async function getOutreachEmail(id: string): Promise<OutreachEmail | null> {
  const { data, error } = await supabaseAdmin
    .from("outreach_emails")
    .select("*, author:authors(*, domain:domains(*))")
    .eq("id", id)
    .single();
  if (error) return null;
  return data;
}

// Not a real .upsert() — the (workflow_id, author_id, kind) uniqueness is enforced by a
// PARTIAL index (excluding kind='negotiation'), and Postgres's ON CONFLICT inference can't
// match a partial index unless the same predicate is repeated in the conflict clause, which
// supabase-js's onConflict (a plain column list) can't express. So this does the check itself.
export async function upsertOutreachEmail(data: {
  workflow_id: string;
  author_id: string;
  template_id?: string;
  subject?: string;
  body?: string;
  status?: string;
}): Promise<OutreachEmail> {
  // One initial per (workflow, author): update the existing one if present, else insert. (Was
  // an upsert on the (workflow_id,author_id,kind) unique constraint; that's now a PARTIAL index
  // excluding 'negotiation', which can't serve as an ON CONFLICT arbiter — the partial index
  // still guards against duplicate initials.)
  const { data: existing } = await supabaseAdmin
    .from("outreach_emails").select("id")
    .eq("workflow_id", data.workflow_id).eq("author_id", data.author_id).eq("kind", "initial")
    .maybeSingle();
  const payload = { ...data, kind: "initial", status: data.status ?? "draft" };
  const q = existing?.id
    ? supabaseAdmin.from("outreach_emails").update(payload).eq("id", existing.id)
    : supabaseAdmin.from("outreach_emails").insert(payload);
  const { data: email, error } = await q.select().single();
  if (error) throw error;
  return email;
}

export async function updateOutreachEmail(id: string, data: {
  subject?: string;
  body?: string;
  status?: string;
  sender_email?: string | null;  // stamped when a human manually sends/schedules a cron-drafted pitch
  sent_by_email?: string | null;
  scheduled_at?: string | null; // null = unschedule (cancel a queued send)
  sent_at?: string | null;
  error?: string | null;
  replied_at?: string | null; // set by IMAP reply detection (real human replies only)
  message_id?: string | null; // RFC Message-ID we sent with, for reply threading
  followup_skipped?: boolean;  // per-email safety valve for auto follow-ups
  ai_managed?: boolean;        // may the AI negotiator auto-send replies on this thread (drafting happens regardless)
  success_at?: string | null;
  success_link?: string | null;
  success_notes?: string | null;
  reply_kind?: string | null;    // reply | bounce | auto — classification of the inbound match
  reply_from?: string | null;
  reply_subject?: string | null;
  reply_excerpt?: string | null;
  reply_sentiment?: string | null; // positive | neutral | negative
  reply_intent?: string | null;  // interested | asks_price | wants_topic | not_interested | follow_up_later | other
  bounced_at?: string | null;    // set when the address bounced (not a real reply)
  edited_at?: string | null;     // wording review audit (055) — stamped whenever subject/body change
  edited_by?: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("outreach_emails").update(data).eq("id", id);
  if (error) throw error;
}

// ─── Reply detection (IMAP) ─────────────────────────────────────────────────────

// Outstanding sent emails (last N days, no reply yet) grouped by the mailbox that sent
// them, with the recipient + subject needed for reply matching. sender_email "" = legacy
// env-sender sends (checked against the env SMTP account).
export async function getOutstandingSentForReplyCheck(days = 30, opts: { includeReplied?: boolean } = {}): Promise<Map<string, Array<{ id: string; author_id: string; message_id: string | null; recipient: string; subject: string; sent_at: string; kind: string | null; parent_id: string | null }>>> {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  // Normal sweep skips already-replied and already-bounced sends. A rescan (includeReplied)
  // re-examines everything so mis-classified past "replies" (bounces) get corrected.
  let q = supabaseAdmin
    .from("outreach_emails")
    .select("id, author_id, sender_email, message_id, subject, sent_at, kind, parent_id, author:authors(contacts(type, value))")
    .eq("status", "sent")
    .is("bounced_at", null)
    .gte("sent_at", since)
    .limit(2000);
  if (!opts.includeReplied) q = q.is("replied_at", null);
  const { data, error } = await q;
  // Throw, or the reply sweep silently checks nothing and reports "0 replies found" as a fact.
  if (error) throw error;
  const out = new Map<string, Array<{ id: string; author_id: string; message_id: string | null; recipient: string; subject: string; sent_at: string; kind: string | null; parent_id: string | null }>>();
  for (const e of data ?? []) {
    const mailto = ((e as any).author?.contacts ?? []).find((c: any) => c.type === "mailto");
    const recipient = mailto ? (mailto.value as string).replace(/^mailto:/, "") : "";
    if (!recipient) continue;
    const key = (e as any).sender_email ?? "";
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push({ id: e.id, author_id: (e as any).author_id, message_id: (e as any).message_id ?? null, recipient, subject: e.subject ?? "", sent_at: (e as any).sent_at, kind: (e as any).kind ?? null, parent_id: (e as any).parent_id ?? null });
  }
  return out;
}

// Record a detected inbound reply on a thread's ANCHOR (initial) row, idempotently. Returns
// true only when this is a genuinely new/changed reply (so the caller counts it and cancels
// pending follow-ups). If the anchor already carries the same reply excerpt, it does nothing
// and returns false — so re-seeing the same message on a later IMAP sweep never bumps
// replied_at (which would wrongly re-trigger auto-negotiation).
// ─── Negotiation activity (who-did-what audit log on the shared Negotiation page) ──────────────
export async function logNegotiationActivity(anchorId: string, actor: string, action: string, detail?: string, authorId?: string | null): Promise<void> {
  try {
    await supabaseAdmin.from("negotiation_activity").insert({ anchor_id: anchorId, actor: actor || "unknown", action, detail: detail ?? null, author_id: authorId ?? null });
  } catch { /* best-effort — never block the action on the audit write */ }
}

export async function getNegotiationActivity(anchorId: string, limit = 30): Promise<Array<{ actor: string; action: string; detail: string | null; created_at: string }>> {
  const { data } = await supabaseAdmin
    .from("negotiation_activity").select("actor, action, detail, created_at")
    .eq("anchor_id", anchorId).order("created_at", { ascending: false }).limit(limit);
  return (data ?? []) as any;
}

// Records a genuine reply on the thread ANCHOR (the initial). `replyAtIso` is the reply's REAL
// date, not the sweep time. Monotonic + idempotent: it advances `replied_at` ONLY for a
// genuinely newer reply. Re-detecting the same (or older) reply on a later IMAP sweep returns
// false and leaves replied_at untouched, so it can never bump forward past our last sent answer
// and re-trigger auto-negotiation (that was the multi-reply runaway). Returns true only when a
// NEW reply was recorded.
export async function recordReplyOnAnchor(
  anchorId: string,
  meta: { reply_kind?: string | null; reply_from?: string | null; reply_subject?: string | null; reply_excerpt?: string | null; reply_sentiment?: string | null; reply_intent?: string | null },
  replyAtIso: string,
): Promise<boolean> {
  const { data } = await supabaseAdmin.from("outreach_emails").select("replied_at, reply_excerpt").eq("id", anchorId).maybeSingle();
  const existingAt = (data as any)?.replied_at as string | null;
  const prev = ((data as any)?.reply_excerpt ?? "").trim();
  const next = (meta.reply_excerpt ?? "").trim();
  // Exact same reply already on file — never re-stamp.
  if (existingAt && prev && prev === next) return false;
  // A re-detection of an already-recorded (same-or-older) reply — do NOT advance replied_at,
  // or the auto-negotiation guard would think a fresh reply arrived and answer again.
  if (existingAt && replyAtIso && new Date(replyAtIso).getTime() <= new Date(existingAt).getTime()) return false;
  await supabaseAdmin.from("outreach_emails").update({ ...meta, replied_at: replyAtIso, bounced_at: null }).eq("id", anchorId);
  return true;
}

export async function markEmailsReplied(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await supabaseAdmin.from("outreach_emails").update({ replied_at: new Date().toISOString() }).in("id", ids).is("replied_at", null);
}

export async function markRepliesChecked(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await supabaseAdmin.from("outreach_emails").update({ reply_checked_at: new Date().toISOString() }).in("id", ids);
}

// ─── Auto follow-ups ────────────────────────────────────────────────────────────

// A newly-scheduled follow-up sends this far in the future, giving a visible date and a
// window to toggle it off before it goes out. Candidates are already >2 days past their
// initial send, so this is the review buffer, not the 2-day wait itself.
export const FOLLOWUP_LEAD_MS = 24 * 60 * 60 * 1000;

// A follow-up nudge past this age stops making sense ("circling back" on a month-old cold email
// reads as automation, not interest) — and the bound is also the recovery valve: after any stall,
// restart nudges only the recent sends instead of bursting the entire historical backlog at once.
export const FOLLOWUP_MAX_AGE_DAYS = 14;

// Initial sends older than `days` (but younger than FOLLOWUP_MAX_AGE_DAYS) with no reply, no
// success, not skipped, and no follow-up yet — the candidates for an automatic threaded follow-up.
//
// Paged, not a single oldest-first fetch: rows that fail the in-JS filters (already has a
// follow-up child, no mailto contact) keep matching the SQL forever, and with one fixed-size
// fetch they eventually OWN the window — which is exactly what happened: by 2026-07-22 the
// oldest 150 unanswered sends all had follow-ups already, every run fetched those same 150,
// filtered all of them, and returned [] — the engine was silently dead for a month. Paging keeps
// scanning past them; rows with no recipient are RETURNED (recipient: "") so runFollowups can
// stamp them followup_skipped and drain them from the scan.
export async function getEmailsNeedingFollowup(days = 2, limit = 25): Promise<Array<{
  id: string; workflow_id: string; author_id: string; template_id: string | null;
  subject: string; sender_email: string | null; sent_by_email: string | null; message_id: string | null;
  recipient: string; author_name: string; publication: string; guidance: string | null;
}>> {
  const now = Date.now();
  const before = new Date(now - days * 86400_000).toISOString();
  const oldest = new Date(now - FOLLOWUP_MAX_AGE_DAYS * 86400_000).toISOString();
  const PAGE = 150;
  const MAX_PAGES = 40; // runtime backstop (~6000 rows/run); the age bound keeps real scans far smaller
  const guidanceById = new Map<string, string | null>();
  const out: any[] = [];

  for (let page = 0; page < MAX_PAGES && out.length < limit; page++) {
    const { data } = await supabaseAdmin
      .from("outreach_emails")
      .select("id, workflow_id, author_id, template_id, subject, sender_email, sent_by_email, message_id, author:authors(full_name, contacts(type, value), domain:domains(name, host))")
      .eq("status", "sent").eq("kind", "initial")
      .is("replied_at", null).is("success_at", null).eq("followup_skipped", false)
      .lte("sent_at", before).gte("sent_at", oldest)
      .order("sent_at", { ascending: true }).order("id", { ascending: true }) // id breaks sent_at ties so pages never overlap
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const rows = data ?? [];
    if (rows.length === 0) break;

    // Exclude any that already have a follow-up child. createFollowupRow now stamps the parent
    // followup_skipped, so this mostly guards rows from before that stamp existed (and parents
    // whose flag was cleared by re-arming a follow-up in the UI).
    const ids = rows.map((r) => r.id);
    const { data: kids } = await supabaseAdmin.from("outreach_emails").select("parent_id").eq("kind", "followup").in("parent_id", ids);
    const hasChild = new Set((kids ?? []).map((k: any) => k.parent_id));

    // Load each involved template's guidance once per page.
    const templateIds = [...new Set(rows.map((r) => (r as any).template_id).filter((t) => t && !guidanceById.has(t as string)))] as string[];
    if (templateIds.length > 0) {
      const { data: tpls } = await supabaseAdmin.from("email_templates").select("id, guidance").in("id", templateIds);
      for (const t of tpls ?? []) guidanceById.set(t.id, (t as any).guidance ?? null);
    }

    for (const r of rows) {
      if (hasChild.has(r.id)) continue;
      const a: any = (r as any).author ?? {};
      const mailto = (a.contacts ?? []).find((c: any) => c.type === "mailto");
      const recipient = mailto ? (mailto.value as string).replace(/^mailto:/, "") : "";
      out.push({
        id: r.id, workflow_id: r.workflow_id, author_id: r.author_id, template_id: (r as any).template_id ?? null,
        subject: r.subject ?? "", sender_email: (r as any).sender_email ?? null, sent_by_email: (r as any).sent_by_email ?? null,
        message_id: (r as any).message_id ?? null, recipient,
        author_name: a.full_name ?? "there", publication: a.domain?.name ?? a.domain?.host ?? "your work",
        guidance: (r as any).template_id ? guidanceById.get((r as any).template_id) ?? null : null,
      });
      if (out.length >= limit) break;
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

// Insert the follow-up as its own row (kind='followup') linked to its parent, then it's
// delivered + stamped sent by the caller.
export async function createFollowupRow(data: {
  workflow_id: string; author_id: string; parent_id: string; subject: string; body: string;
  sender_email: string | null; sent_by_email: string | null;
  status?: string; scheduled_at?: string | null;
}): Promise<{ id: string }> {
  const { data: row, error } = await supabaseAdmin
    .from("outreach_emails")
    .insert({
      workflow_id: data.workflow_id, author_id: data.author_id, parent_id: data.parent_id,
      kind: "followup", subject: data.subject, body: data.body,
      status: data.status ?? "ready", scheduled_at: data.scheduled_at ?? null,
      sender_email: data.sender_email, sent_by_email: data.sent_by_email,
    })
    .select("id").single();
  if (error) throw error;
  // The parent's thread now has its one follow-up — stamp it so it leaves the candidate QUERY,
  // not just the in-JS filter. Unstamped parents re-match the SQL on every run forever, and an
  // accumulation of them is what jammed the candidate window (see getEmailsNeedingFollowup).
  await supabaseAdmin.from("outreach_emails").update({ followup_skipped: true }).eq("id", data.parent_id);
  return row;
}

// Arm / disarm a single scheduled follow-up. Disarming parks the follow-up (status='draft',
// no schedule) AND marks its parent followup_skipped so runFollowups never regenerates it.
// Re-arming reschedules it and clears the parent flag. Only meaningful while it's unsent.
export async function setFollowupArmed(followupId: string, armed: boolean): Promise<{ ok: boolean; error?: string }> {
  const { data: fu } = await supabaseAdmin
    .from("outreach_emails").select("id, parent_id, status, kind").eq("id", followupId).single();
  if (!fu || (fu as any).kind !== "followup") return { ok: false, error: "not a follow-up" };
  if ((fu as any).status === "sent") return { ok: false, error: "already sent" };
  if (armed) {
    const when = new Date(Date.now() + FOLLOWUP_LEAD_MS).toISOString();
    await supabaseAdmin.from("outreach_emails").update({ status: "scheduled", scheduled_at: when, error: null }).eq("id", followupId);
    if ((fu as any).parent_id) await supabaseAdmin.from("outreach_emails").update({ followup_skipped: false }).eq("id", (fu as any).parent_id);
  } else {
    await supabaseAdmin.from("outreach_emails").update({ status: "draft", scheduled_at: null }).eq("id", followupId);
    if ((fu as any).parent_id) await supabaseAdmin.from("outreach_emails").update({ followup_skipped: true }).eq("id", (fu as any).parent_id);
  }
  return { ok: true };
}

// The threading + engagement info a follow-up needs at send time: the parent's Message-ID
// (to thread the reply) and whether the parent has since been replied to / converted.
export async function getFollowupParent(parentId: string): Promise<{ message_id: string | null; replied_at: string | null; success_at: string | null } | null> {
  const { data } = await supabaseAdmin
    .from("outreach_emails").select("message_id, replied_at, success_at").eq("id", parentId).single();
  if (!data) return null;
  return { message_id: (data as any).message_id ?? null, replied_at: (data as any).replied_at ?? null, success_at: (data as any).success_at ?? null };
}

// Authors that lack an email (no mailto contact), optionally scoped to one campaign.
// Returns id + name + publication domain host so the finder can run the waterfall.
export async function getAuthorsNeedingEmail(
  campaignId?: string,
  onlyNew = false,
  /** Retry mode with a staleness bound: include never-searched authors AND those whose last
   *  search is older than this many days. Without it, only_new=false re-bills providers for
   *  yesterday's failures; with it, a periodic retry only touches searches old enough that the
   *  providers' indexes may actually have changed. */
  staleDays?: number,
): Promise<Array<{ id: string; name: string; host: string; publication: string }>> {
  let candidateIds: Set<string> | null = null;
  if (campaignId) {
    candidateIds = await getCampaignAuthorIds(campaignId);
    if (candidateIds.size === 0) return [];
  }

  // authors that already have a mailto contact — to exclude
  const withEmail = new Set(
    (await fetchAllRows<{ author_id: string }>("contacts", "author_id", (q) => q.eq("type", "mailto"))).map((r) => r.author_id)
  );

  const rows = await fetchAllRows<{ id: string; full_name: string; email_search_attempted_at: string | null; domain: { host: string; name: string } | null }>(
    "authors",
    "id, full_name, email_search_attempted_at, domain:domains!primary_domain_id(host, name)",
    (q) => q.not("primary_domain_id", "is", null),
  );

  const staleBefore = staleDays != null && staleDays > 0 ? Date.now() - staleDays * 86_400_000 : null;
  return rows
    .filter((r) => !withEmail.has(r.id))
    .filter((r) => !onlyNew || !r.email_search_attempted_at) // "brand new" = never attempted before, regardless of outcome
    .filter((r) => staleBefore === null || !r.email_search_attempted_at || Date.parse(r.email_search_attempted_at) < staleBefore)
    .filter((r) => !candidateIds || candidateIds.has(r.id))
    .filter((r) => r.domain?.host)
    .map((r) => ({ id: r.id, name: r.full_name, host: r.domain!.host, publication: r.domain!.name ?? r.domain!.host }));
}

export async function markEmailSearchAttempted(authorId: string): Promise<void> {
  await supabaseAdmin.from("authors").update({ email_search_attempted_at: new Date().toISOString() }).eq("id", authorId);
}

// Authors (in a campaign, or all) that DON'T yet have a stored LinkedIn contact — the
// targets for the LinkedIn finder's one-time pass. LinkedIn is higher-hit-rate than email.
export async function getAuthorsNeedingLinkedin(campaignId?: string): Promise<Array<{ id: string; name: string; host: string; publication: string }>> {
  let candidateIds: Set<string> | null = null;
  if (campaignId) {
    candidateIds = await getCampaignAuthorIds(campaignId);
    if (candidateIds.size === 0) return [];
  }

  const withLinkedin = new Set(
    (await fetchAllRows<{ author_id: string }>("contacts", "author_id", (q) => q.eq("type", "linkedin"))).map((r) => r.author_id)
  );

  const rows = await fetchAllRows<{ id: string; full_name: string; domain: { host: string; name: string } | null }>(
    "authors",
    "id, full_name, domain:domains!primary_domain_id(host, name)",
    (q) => q.not("primary_domain_id", "is", null),
  );

  return rows
    .filter((r) => !withLinkedin.has(r.id))
    .filter((r) => !candidateIds || candidateIds.has(r.id))
    .filter((r) => r.domain?.host)
    .map((r) => ({ id: r.id, name: r.full_name, host: r.domain!.host, publication: r.domain!.name ?? r.domain!.host }));
}

// Denominator + numerator for the Email/LinkedIn finder: how many prospects in the pool
// (campaign, or all authors with a publication) still lack an email (or LinkedIn), of the
// total pool. Matches the finder's own target set.
export async function getFinderCounts(campaignId: string | undefined, mode: "email" | "linkedin", onlyNew = false): Promise<{ total: number; needing: number }> {
  const candidateIds = campaignId ? await getCampaignAuthorIds(campaignId) : null;
  if (candidateIds && candidateIds.size === 0) return { total: 0, needing: 0 };

  const type = mode === "linkedin" ? "linkedin" : "mailto";
  const withContact = new Set(
    (await fetchAllRows<{ author_id: string }>("contacts", "author_id", (q) => q.eq("type", type))).map((r) => r.author_id)
  );
  const rows = await fetchAllRows<{ id: string; email_search_attempted_at: string | null; domain: { host: string } | null }>(
    "authors", "id, email_search_attempted_at, domain:domains!primary_domain_id(host)", (q) => q.not("primary_domain_id", "is", null),
  );
  const pool = rows.filter((r) => r.domain?.host && (!candidateIds || candidateIds.has(r.id)));
  return {
    total: pool.length,
    needing: pool.filter((r) => !withContact.has(r.id) && (mode === "linkedin" || !onlyNew || !r.email_search_attempted_at)).length,
  };
}

// Known (author name, email) pairs for a domain — used to infer the domain's email
// pattern for free. Pools every author whose publication is on the SAME registrable domain
// (www.ibm.com + research.ibm.com + newsroom.ibm.com → one ibm.com pattern) so subdomains
// don't each infer a different pattern. Over-fetches by host-substring, then filters exactly.
export async function getKnownEmailsByDomain(host: string): Promise<Array<{ name: string; email: string }>> {
  const reg = registrableDomain(host);
  const { data } = await supabaseAdmin
    .from("contacts")
    .select("value, author:authors!inner(full_name, domain:domains!primary_domain_id!inner(host))")
    .eq("type", "mailto")
    .ilike("author.domain.host", `%${reg}`)
    .limit(500);
  return (data ?? [])
    .map((r: any) => ({
      name: r.author?.full_name as string,
      email: (r.value as string).replace(/^mailto:/, "").toLowerCase(),
      host: (r.author?.domain?.host ?? "") as string,
    }))
    .filter((r: any) => r.name && r.email)
    // Precise match on BOTH sides: the author's publication AND the email must be on this
    // exact registrable domain. `%ibm.com` also catches `notibm.com`, so re-check host here.
    // And a Fast Company writer whose contact is a personal gmail must not poison inference.
    .filter((r: any) => registrableDomain(r.host) === reg && registrableDomain(r.email.split("@")[1] ?? "") === reg)
    .map((r: any) => ({ name: r.name, email: r.email }));
}

// An author's already-stored LinkedIn URL, if any — so the email cascade can reuse it and
// skip the (paid) web search + post scan. Normalized to an absolute https URL.
export async function getStoredLinkedin(authorId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("contacts").select("value").eq("author_id", authorId).eq("type", "linkedin").limit(1).maybeSingle();
  const v = (data as any)?.value as string | undefined;
  if (!v) return null;
  return v.startsWith("http") ? v : `https://${v}`;
}

// All of an author's article URLs (most recent first, capped) — scraped during
// enrichment to hunt for their LinkedIn / contact info across everything they wrote.
export async function getAuthorArticleUrls(authorId: string, limit = 50): Promise<string[]> {
  const aa = await fetchAllRows<{ article_id: string }>("article_authors", "article_id", (q) => q.eq("author_id", authorId));
  if (!aa.length) return [];
  const ids = aa.map((r) => r.article_id).slice(0, 500);
  const urls: string[] = [];
  for (let i = 0; i < ids.length && urls.length < limit; i += 200) {
    const { data } = await supabaseAdmin
      .from("articles")
      .select("url_canonical, published_at")
      .in("id", ids.slice(i, i + 200))
      .order("published_at", { ascending: false });
    urls.push(...(data ?? []).map((r: any) => r.url_canonical).filter(Boolean));
  }
  return urls.slice(0, limit);
}

// Persist inferred author timezones (authorId → IANA tz) so we only infer once.
export async function setAuthorTimezones(map: Record<string, string>): Promise<void> {
  const entries = Object.entries(map);
  for (const [authorId, tz] of entries) {
    await supabaseAdmin.from("authors").update({ timezone: tz }).eq("id", authorId).then(() => {});
  }
}

// ─── Enrichment run history ─────────────────────────────────────────────────
export async function saveEnrichmentRun(run: {
  key: string; campaignName?: string; total: number; done: number; found: number;
  bySource: Record<string, number>; people: any[]; startedAt: number;
}): Promise<void> {
  await supabaseAdmin.from("enrichment_runs").insert({
    campaign_id: run.key, campaign_name: run.campaignName ?? null,
    total: run.total, done: run.done, found: run.found,
    by_source: run.bySource, people: run.people,
    started_at: new Date(run.startedAt).toISOString(), finished_at: new Date().toISOString(),
  }).then(() => {});
}

export async function getEnrichmentRuns(limit = 25): Promise<any[]> {
  const { data, error } = await supabaseAdmin
    .from("enrichment_runs")
    .select("id, campaign_name, total, done, found, by_source, started_at, finished_at")
    .order("finished_at", { ascending: false })
    .limit(limit);
  if (error) throw error; // a failed read is not an empty run history
  return data ?? [];
}

export async function getEnrichmentRun(id: string): Promise<any | null> {
  const { data, error } = await supabaseAdmin.from("enrichment_runs").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// A reply / bounce / win means: stop any not-yet-sent follow-up to this author, so a
// previously-scheduled nudge never lands after they've already engaged. Parks them as drafts
// (status/scheduled_at cleared — kept for the record, never auto-sent). Returns how many
// were stopped. Mirrors the send-time guard in /api/emails/process.
export async function stopPendingFollowupsForAuthor(authorId: string, reason: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from("outreach_emails")
    .update({ status: "draft", scheduled_at: null, followup_skipped: true, error: reason })
    .eq("author_id", authorId).eq("kind", "followup").in("status", ["scheduled", "pending"])
    .select("id");
  return (data ?? []).length;
}

// Author IDs already contacted (or queued) in OTHER campaigns/workflows — so we never
// email the same person twice across campaigns. "Contacted" = a sent or scheduled
// outreach email in any workflow other than the one given.
export async function getContactedAuthorIds(excludeWorkflowId?: string): Promise<Set<string>> {
  // "Contacted" = actually emailed, judged by durable signals (sent_at / replied_at /
  // bounced_at) as well as current status. Regenerating an email resets status to 'ready' but
  // leaves sent_at/replied_at intact, so status alone would wrongly forget an emailed person.
  const rows = await fetchAllRows<{ author_id: string; workflow_id: string }>(
    "outreach_emails",
    "author_id, workflow_id",
    (q) => q.or("status.in.(sent,scheduled),sent_at.not.is.null,replied_at.not.is.null,bounced_at.not.is.null"),
  );
  const set = new Set<string>();
  for (const r of rows) {
    if (excludeWorkflowId && r.workflow_id === excludeWorkflowId) continue;
    set.add(r.author_id);
  }
  // Email-level propagation: an inbox is contacted, not just a person. The address we emailed
  // is the author's mailto contact, so map every contacted author → their address(es), then
  // pull in any OTHER author sharing one of those addresses (common with shared editorial
  // inboxes) — so we never hit the same inbox twice and both show the same "contacted" tag.
  if (set.size > 0) {
    const mailtos = await fetchAllRows<{ author_id: string; value: string }>(
      "contacts", "author_id, value", (q) => q.eq("type", "mailto"),
    );
    const contactedAddrs = new Set<string>();
    for (const c of mailtos) {
      if (!set.has(c.author_id)) continue;
      const addr = (c.value ?? "").replace(/^mailto:/i, "").trim().toLowerCase();
      if (addr.includes("@")) contactedAddrs.add(addr);
    }
    if (contactedAddrs.size > 0) {
      for (const c of mailtos) {
        const addr = (c.value ?? "").replace(/^mailto:/i, "").trim().toLowerCase();
        if (addr && contactedAddrs.has(addr)) set.add(c.author_id);
      }
    }
  }
  // Apply manual overrides from the prospect drawer: true → force contacted, false → force
  // NOT contacted ("email them again"). This wins over the derived history above.
  const overrides = await fetchAllRows<{ id: string; contacted_override: boolean | null }>(
    "authors", "id, contacted_override", (q) => q.not("contacted_override", "is", null),
  );
  for (const o of overrides) {
    if (o.contacted_override === true) set.add(o.id);
    else if (o.contacted_override === false) set.delete(o.id);
  }
  return set;
}

// Manual override of an author's contacted state (from the prospect drawer's "Emailed"
// toggle). Pass null to clear it and fall back to derived-from-outreach behavior.
export async function setContactedOverride(authorId: string, value: boolean | null): Promise<void> {
  await supabaseAdmin.from("authors").update({ contacted_override: value }).eq("id", authorId);
}

// Discard an author — hidden from every workflow (runWorkflowFilters excludes discarded).
export async function setAuthorDiscarded(authorId: string, discarded: boolean): Promise<void> {
  await supabaseAdmin.from("authors").update({ discarded }).eq("id", authorId);
}

// Whether ONE author counts as contacted right now (derived history OR manual override).
// "History" includes the SHARED-INBOX case: if any of this author's email addresses was
// already emailed — even via a different author — this author counts as contacted too.
export async function isAuthorContacted(authorId: string): Promise<{ contacted: boolean; override: boolean | null; hasHistory: boolean }> {
  const [authorRes, ownEmailsRes, myContactsRes] = await Promise.all([
    supabaseAdmin.from("authors").select("contacted_override").eq("id", authorId).maybeSingle(),
    supabaseAdmin.from("outreach_emails").select("id").eq("author_id", authorId).in("status", ["sent", "scheduled"]).limit(1),
    supabaseAdmin.from("contacts").select("value").eq("author_id", authorId).eq("type", "mailto"),
  ]);
  // "Not contacted" green-lights another email — never let a failed read say it.
  for (const r of [authorRes, ownEmailsRes, myContactsRes]) if (r.error) throw r.error;
  const author = authorRes.data, ownEmails = ownEmailsRes.data, myContacts = myContactsRes.data;
  let hasHistory = (ownEmails ?? []).length > 0;
  // Shared-inbox propagation: was any of this author's addresses already emailed via ANOTHER
  // author? Find the authors that share this author's mailto address(es), then check whether
  // any of them has outreach history. (recipient = the author's mailto contact, so we match on
  // the address, not a non-existent recipient column.)
  if (!hasHistory) {
    const myAddrs = new Set((myContacts ?? [])
      .map((c: any) => (c.value ?? "").replace(/^mailto:/i, "").trim().toLowerCase())
      .filter((v: string) => v.includes("@")));
    if (myAddrs.size > 0) {
      // Normalize BOTH sides (strip mailto:, lowercase) and match in memory, so this agrees
      // with getContactedAuthorIds even if an address was ever stored mixed-case or unprefixed.
      const all = await fetchAllRows<{ author_id: string; value: string }>("contacts", "author_id, value", (q) => q.eq("type", "mailto"));
      const sharerIds = [...new Set(all
        .filter((c) => { const a = (c.value ?? "").replace(/^mailto:/i, "").trim().toLowerCase(); return !!a && myAddrs.has(a) && c.author_id !== authorId; })
        .map((c) => c.author_id))];
      if (sharerIds.length > 0) {
        const { data } = await supabaseAdmin
          .from("outreach_emails").select("id").in("author_id", sharerIds).in("status", ["sent", "scheduled"]).limit(1);
        if ((data ?? []).length > 0) hasHistory = true;
      }
    }
  }
  const override = (author?.contacted_override ?? null) as boolean | null;
  const contacted = override === true ? true : override === false ? false : hasHistory;
  return { contacted, override, hasHistory };
}

// ─── Negotiation conversation + payments ───────────────────────────────────────

export interface ConvoMessage { from: "us" | "them"; body: string; at: string | null; kind?: string }

// Reconstruct the full conversation for a thread anchor (the initial outreach): our sent
// messages (initial + follow-ups + negotiation replies) interleaved with their reply excerpts,
// oldest first. Used by the Negotiation and Payments pages.
export async function getConversation(anchorId: string): Promise<ConvoMessage[]> {
  const { data, error } = await supabaseAdmin
    .from("outreach_emails")
    .select("id, kind, body, status, created_at, sent_at, reply_excerpt, replied_at")
    .or(`id.eq.${anchorId},parent_id.eq.${anchorId}`)
    .order("created_at", { ascending: true });
  if (error) throw error; // a failed read is not an empty conversation
  const msgs: ConvoMessage[] = [];
  for (const r of (data ?? []) as any[]) {
    // Only actually-sent messages belong in the conversation history. An unsent draft ('draft')
    // is shown separately in the editable draft box, so including it here double-renders it.
    if (r.body && r.status !== "failed" && r.status !== "draft") msgs.push({ from: "us", body: r.body, at: r.sent_at ?? r.created_at, kind: r.kind });
    if (r.reply_excerpt) msgs.push({ from: "them", body: r.reply_excerpt, at: r.replied_at });
  }
  return msgs;
}

export interface PaymentThread {
  id: string; name: string; publication: string; host: string; dr: number | null;
  sender: string | null; sentBy: string | null; agreedPrice: number | null; paidAmount: number | null;
  status: string | null; paidAt: string | null; requestedAt: string | null; subject: string;
}

// Threads that resulted in a deal: negotiation agreed (owed) or any explicit payment_status.
export async function getPaymentThreads(): Promise<PaymentThread[]> {
  const sel = "id, subject, sender_email, sent_by_email, agreed_price, paid_amount, payment_status, paid_at, payment_requested_at, negotiation_status, sent_at, created_at, author:authors(full_name, domain:domains(host, name, dr))";
  const [agreed, withPay] = await Promise.all([
    supabaseAdmin.from("outreach_emails").select(sel).eq("kind", "initial").eq("negotiation_status", "agreed"),
    supabaseAdmin.from("outreach_emails").select(sel).eq("kind", "initial").not("payment_status", "is", null),
  ]);
  if (agreed.error) throw agreed.error;
  if (withPay.error) throw withPay.error;
  const byId = new Map<string, any>();
  for (const r of [...(agreed.data ?? []), ...(withPay.data ?? [])]) byId.set((r as any).id, r);
  return [...byId.values()]
    .sort((a, b) => String(b.paid_at ?? b.sent_at ?? b.created_at ?? "").localeCompare(String(a.paid_at ?? a.sent_at ?? a.created_at ?? "")))
    .map((r: any) => ({
      id: r.id, name: r.author?.full_name ?? "Unknown",
      publication: r.author?.domain?.name ?? r.author?.domain?.host ?? "", host: r.author?.domain?.host ?? "",
      dr: r.author?.domain?.dr ?? null, sender: r.sender_email, sentBy: r.sent_by_email,
      agreedPrice: r.agreed_price != null ? Number(r.agreed_price) : null,
      paidAmount: r.paid_amount != null ? Number(r.paid_amount) : null,
      status: r.payment_status ?? (r.negotiation_status === "agreed" ? "owed" : null),
      paidAt: r.paid_at, requestedAt: r.payment_requested_at, subject: r.subject ?? "",
    }));
}

export async function markPayment(id: string, action: "paid" | "request" | "reset"): Promise<void> {
  const now = new Date().toISOString();
  if (action === "paid") {
    const { data } = await supabaseAdmin.from("outreach_emails").select("agreed_price").eq("id", id).maybeSingle();
    await supabaseAdmin.from("outreach_emails").update({ payment_status: "paid", paid_at: now, paid_amount: (data as any)?.agreed_price ?? null }).eq("id", id);
  } else if (action === "request") {
    await supabaseAdmin.from("outreach_emails").update({ payment_status: "requested", payment_requested_at: now }).eq("id", id);
  } else {
    await supabaseAdmin.from("outreach_emails").update({ payment_status: "owed", paid_at: null }).eq("id", id);
  }
}

// ─── Per-user email config (own Gmail + own schedule) ──────────────────────────

const DEFAULT_USER_CONFIG = { timezone: "America/New_York", send_hour_start: 9, send_hour_end: 17, gap_minutes: 15, daily_cap: 50 };

// Client-safe config (no password). Returns defaults (hasPassword=false) if unset.
export async function getUserEmailConfig(userEmail: string): Promise<import("@/lib/types").UserEmailConfig> {
  const { data, error } = await supabaseAdmin.from("user_email_config").select("*").eq("user_email", userEmail).maybeSingle();
  // Throw: a failed read used to render "add your Gmail app password" over a stored one, and
  // hand out DEFAULT hours/caps as if they were the user's.
  if (error) throw error;
  return {
    user_email: userEmail,
    from_name: data?.from_name ?? undefined,
    timezone: data?.timezone ?? DEFAULT_USER_CONFIG.timezone,
    send_hour_start: data?.send_hour_start ?? DEFAULT_USER_CONFIG.send_hour_start,
    send_hour_end: data?.send_hour_end ?? DEFAULT_USER_CONFIG.send_hour_end,
    gap_minutes: data?.gap_minutes ?? DEFAULT_USER_CONFIG.gap_minutes,
    daily_cap: data?.daily_cap ?? DEFAULT_USER_CONFIG.daily_cap,
    hasPassword: !!data?.app_password_enc,
  };
}

export async function upsertUserEmailConfig(userEmail: string, data: {
  app_password_enc?: string; from_name?: string; timezone?: string;
  send_hour_start?: number; send_hour_end?: number; gap_minutes?: number; daily_cap?: number;
  shared_sender_label?: string | null; shared_sender_enabled?: boolean;
}): Promise<void> {
  const { error } = await supabaseAdmin
    .from("user_email_config")
    .upsert({ user_email: userEmail, ...data, updated_at: new Date().toISOString() }, { onConflict: "user_email" });
  if (error) throw error;
}

// Server-only: the encrypted app password for a sender (decrypted by the caller at send time).
export async function getUserAppPasswordEnc(userEmail: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from("user_email_config").select("app_password_enc").eq("user_email", userEmail).maybeSingle();
  if (error) throw error; // null means "no password stored", never "the read failed"
  return (data?.app_password_enc as string | undefined) ?? null;
}

// ─── Shared sending identities (e.g. Zain) — admin-managed, DB-driven ──────────────

export interface SharedSenderRow { email: string; label: string; enabled: boolean; hasPassword: boolean }

// Every configured shared sender, enabled or not — for the Admin management list.
// Every configured team mailbox (has an app password) — powers the admin inbox switcher.
export async function getInboxAccounts(): Promise<{ email: string; label: string }[]> {
  const { data, error } = await supabaseAdmin
    .from("user_email_config")
    .select("user_email, from_name, shared_sender_label, app_password_enc")
    .not("app_password_enc", "is", null);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ email: r.user_email, label: r.from_name || r.shared_sender_label || r.user_email }));
}

// Resolve which mailbox to READ: the requested `as` account if it is a real configured mailbox
// (any signed-in team member may view any team inbox), otherwise the caller's own.
//
// Viewing only. The send routes used to take this answer as their FROM identity, which turned an
// open read permission into "anyone signed in may put outreach on the wire from a colleague's
// Gmail". Sending as another mailbox goes through resolveInboxSender (src/lib/email/manualSender.ts),
// which is admin-only.
export async function resolveInboxAccount(me: string, as?: string | null): Promise<string> {
  if (!as || as.toLowerCase() === me.toLowerCase()) return me;
  const accts = await getInboxAccounts();
  return accts.some((a) => a.email.toLowerCase() === as.toLowerCase()) ? as : me;
}

export async function getSharedSenders(): Promise<SharedSenderRow[]> {
  const { data, error } = await supabaseAdmin
    .from("user_email_config")
    .select("user_email, shared_sender_label, shared_sender_enabled, app_password_enc")
    .not("shared_sender_label", "is", null);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    email: r.user_email, label: r.shared_sender_label, enabled: r.shared_sender_enabled, hasPassword: !!r.app_password_enc,
  }));
}

// Only the ones currently toggled on — for the "Send from" picker and for validating a
// chosen sender_email is actually allowed right now.
export async function getEnabledSharedSenders(): Promise<{ email: string; label: string }[]> {
  const { data, error } = await supabaseAdmin
    .from("user_email_config")
    .select("user_email, shared_sender_label")
    .not("shared_sender_label", "is", null)
    .eq("shared_sender_enabled", true);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({ email: r.user_email, label: r.shared_sender_label }));
}

// For display purposes (e.g. labeling past sends) — returns the label even if since
// disabled, so history still reads "from Zain" after a toggle-off.
export async function getSharedSenderLabel(email: string): Promise<string | null> {
  const { data } = await supabaseAdmin.from("user_email_config").select("shared_sender_label").eq("user_email", email).maybeSingle();
  return (data as any)?.shared_sender_label ?? null;
}

// ─── Email send config & scheduling ─────────────────────────────────────────────

const DEFAULT_SEND_CONFIG = {
  timezone: "America/New_York",
  send_hour_start: 9,
  send_hour_end: 17,
  gap_minutes: 15,
  daily_cap: 50,
  provider: "smtp" as const,
};

export async function getSendConfig(workflowId: string): Promise<EmailSendConfig | null> {
  const { data, error } = await supabaseAdmin
    .from("email_send_config")
    .select("*")
    .eq("workflow_id", workflowId)
    .maybeSingle();
  // Null means "never configured" — getSendConfigOrDefault substitutes defaults on exactly that.
  // A failed read must not hand the page defaults it will then SAVE over the real config.
  if (error) throw error;
  return data ?? null;
}

// Returns the stored config, or a sensible default (not persisted) so callers always have one.
export async function getSendConfigOrDefault(workflowId: string): Promise<EmailSendConfig> {
  const existing = await getSendConfig(workflowId);
  if (existing) return existing;
  return { id: "", workflow_id: workflowId, created_at: new Date().toISOString(), ...DEFAULT_SEND_CONFIG };
}

export async function upsertSendConfig(workflowId: string, data: Partial<EmailSendConfig>): Promise<EmailSendConfig> {
  const { data: row, error } = await supabaseAdmin
    .from("email_send_config")
    .upsert({ workflow_id: workflowId, ...data }, { onConflict: "workflow_id" })
    .select()
    .single();
  if (error) throw error;
  return row;
}

// Assign scheduled_at times to a workflow's ready/included emails, in rank order.
// `times` is a parallel array of ISO strings (one per email, in order).
export async function scheduleWorkflowEmails(
  workflowId: string,
  emailIdsInOrder: string[],
  times: string[],
  senderEmail?: string,
  sentByEmail?: string, // who actually clicked Send — tracked separately when sending as a shared inbox
  aiManaged?: boolean,  // mark these threads for AI reply handling (chosen at send time)
  toOverride?: string,  // admin test-send: route every email to this address instead of the prospect's
): Promise<void> {
  const ovr = toOverride?.trim() || null;
  for (let i = 0; i < emailIdsInOrder.length && i < times.length; i++) {
    const patch: Record<string, unknown> = { scheduled_at: times[i], status: "scheduled", error: null };
    if (senderEmail) patch.sender_email = senderEmail; // whose mailbox this sends from
    if (sentByEmail) patch.sent_by_email = sentByEmail;
    if (aiManaged) patch.ai_managed = true;
    if (ovr) patch.recipient_override = ovr; // test target
    await supabaseAdmin.from("outreach_emails").update(patch).eq("id", emailIdsInOrder[i]);
  }
}

// Reschedule every currently-queued email into a new standardised timezone. Recomputes each
// workflow's queue with computeSmartSchedule (its own window/spacing/cap, the new timezone
// for all) and persists the timezone to that workflow's config. Returns how many moved.
export async function rescheduleScheduledToTimezone(timezone: string): Promise<number> {
  const { computeSmartSchedule } = await import("@/lib/email/schedule");
  const rows = await fetchAllRows<{ id: string; workflow_id: string; scheduled_at: string | null }>(
    "outreach_emails", "id, workflow_id, scheduled_at", (q) => q.eq("status", "scheduled"),
  );
  const byWf = new Map<string, string[]>();
  for (const r of rows.sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""))) {
    if (!byWf.has(r.workflow_id)) byWf.set(r.workflow_id, []);
    byWf.get(r.workflow_id)!.push(r.id);
  }
  let moved = 0;
  const now = new Date();
  for (const [workflowId, ids] of byWf) {
    const config = await getSendConfigOrDefault(workflowId);
    const slots = computeSmartSchedule(ids.map((id) => ({ id, tz: timezone })), { ...config, timezone }, now);
    await scheduleWorkflowEmails(workflowId, slots.map((s) => s.id), slots.map((s) => s.at));
    await upsertSendConfig(workflowId, { timezone }).catch(() => {});
    moved += ids.length;
  }
  return moved;
}

// Re-space every currently-queued email for one sender, honouring their window/gap/cap.
//
// This replaces reburstScheduledInitials, which did the opposite: it ran at the start of EVERY
// send-processor run and re-stamped every queued initial onto one instant per sender. That made
// spacing impossible to hold — even a correctly spaced queue was flattened within 30 minutes of
// being created — and it is half of why 23 initials left one Gmail inside 46 seconds on
// 2 Sep 2026. Nothing re-stamps a queue on a schedule now; this exists only to be called
// deliberately, when a sender's pacing settings change and their queue should follow.
//
// Negotiation replies are left alone: they answer a live conversation and are not paced.
export async function respaceSenderQueue(senderEmail: string, now = new Date()): Promise<number> {
  const { computeSmartSchedule } = await import("@/lib/email/schedule");
  const rows = await fetchAllRows<{ id: string; scheduled_at: string | null }>(
    "outreach_emails", "id, scheduled_at",
    (q) => q.eq("status", "scheduled").eq("sender_email", senderEmail).or("kind.is.null,kind.eq.initial,kind.eq.followup"),
  );
  if (!rows.length) return 0;
  // Oldest-scheduled first, so re-spacing preserves the order the queue already had.
  const ids = rows
    .sort((a, b) => (a.scheduled_at ?? "").localeCompare(b.scheduled_at ?? ""))
    .map((r) => r.id);
  const cfg = await getUserEmailConfig(senderEmail);
  const config = {
    id: "", workflow_id: "", provider: "smtp" as const, created_at: "",
    timezone: cfg.timezone, send_hour_start: cfg.send_hour_start, send_hour_end: cfg.send_hour_end,
    gap_minutes: cfg.gap_minutes, daily_cap: cfg.daily_cap,
  };
  const slots = computeSmartSchedule(ids.map((id) => ({ id, tz: config.timezone })), config, now);
  let moved = 0;
  for (const s of slots) {
    const { error } = await supabaseAdmin
      .from("outreach_emails").update({ scheduled_at: s.at }).eq("id", s.id);
    if (!error) moved++;
  }
  return moved;
}

// Sending status for the progress page. Counts are ALL-TIME (via exact count queries, not
// a capped page), so the top stats reflect the entirety of sending history. The queued and
// sent/failed lists are paginated so the UI can "load more" back through everything.
const SEND_COLS = "id, workflow_id, author_id, sender_email, sent_by_email, subject, status, kind, parent_id, scheduled_at, sent_at, error, replied_at, bounced_at, reply_kind, reply_from, reply_subject, reply_excerpt, reply_sentiment, success_at, success_link, success_notes, author:authors(full_name, timezone, contacts(type, source, value), domain:domains(host, country, name))";

export async function getSendingStatus(opts: {
  workflowId?: string;
  upcomingOffset?: number; upcomingLimit?: number;
  recentOffset?: number; recentLimit?: number;
  followupOffset?: number; followupLimit?: number;
  repliedOffset?: number; repliedLimit?: number;
  winsOffset?: number; winsLimit?: number;
} = {}): Promise<{
  counts: Record<string, number>;
  upcoming: any[]; upcomingTotal: number;
  recent: any[]; recentTotal: number;
  followups: any[]; followupsTotal: number;
  replied: any[]; repliedTotal: number;
  wins: any[]; winsTotal: number;
}> {
  const { workflowId } = opts;
  const upcomingOffset = opts.upcomingOffset ?? 0;
  const upcomingLimit = opts.upcomingLimit ?? 50;
  const recentOffset = opts.recentOffset ?? 0;
  const recentLimit = opts.recentLimit ?? 40;
  const followupOffset = opts.followupOffset ?? 0;
  const followupLimit = opts.followupLimit ?? 200;
  const repliedOffset = opts.repliedOffset ?? 0;
  const repliedLimit = opts.repliedLimit ?? 200;
  const winsOffset = opts.winsOffset ?? 0;
  const winsLimit = opts.winsLimit ?? 200;

  const scoped = (q: any) => (workflowId ? q.eq("workflow_id", workflowId) : q);
  // Throw on a failed count: "0 sent, 0 replied, 0 wins" must mean nothing happened, never that
  // the read did. The whole Sending page is these numbers.
  const countOf = (build: (q: any) => any) =>
    build(scoped(supabaseAdmin.from("outreach_emails").select("id", { count: "exact", head: true })))
      .then(({ count, error }: any) => { if (error) throw error; return count ?? 0; });

  // Initials and follow-ups are counted/listed separately so follow-ups only ever surface in
  // the Follow-ups tab (never mixed into Queued or Sent & failed). ROI denominators use the
  // count of *initials* sent (people contacted), not raw sends, so follow-ups don't inflate it.
  const [
    cSentInitial, cFailedInitial, cReplied, cBounced, cSuccess,
    cScheduled, cReady, recentTotal, followupsTotal,
    upcomingRes, recentRes, followupsRes, repliedRes, winsRes,
  ] = await Promise.all([
    countOf((q) => q.eq("status", "sent").eq("kind", "initial")),
    countOf((q) => q.eq("status", "failed").eq("kind", "initial")),
    countOf((q) => q.not("replied_at", "is", null).eq("kind", "initial")),
    countOf((q) => q.not("bounced_at", "is", null).eq("kind", "initial")),
    countOf((q) => q.not("success_at", "is", null)),
    countOf((q) => q.eq("status", "scheduled").eq("kind", "initial")),
    // "ready" = drafted, not yet given a send time. These used to be invisible everywhere
    // until something (autopilot, or the per-workflow Send button) promoted them to
    // "scheduled" — surfacing them in Queued too so a fresh draft never looks like it vanished.
    countOf((q) => q.eq("status", "ready").eq("kind", "initial")),
    // Sent & failed is the chronological record of everything that actually went out —
    // initials AND sent/failed follow-ups (pending follow-ups stay only in the Follow-ups tab).
    countOf((q) => q.in("status", ["sent", "failed"])),
    countOf((q) => q.eq("kind", "followup")),
    // Ready drafts sort first (nullsFirst) — they need action — then scheduled ones by send time.
    scoped(supabaseAdmin.from("outreach_emails").select(SEND_COLS))
      .in("status", ["scheduled", "ready"]).eq("kind", "initial")
      .order("scheduled_at", { ascending: true, nullsFirst: true }).range(upcomingOffset, upcomingOffset + upcomingLimit - 1),
    scoped(supabaseAdmin.from("outreach_emails").select(SEND_COLS))
      .in("status", ["sent", "failed"])
      .order("sent_at", { ascending: false, nullsFirst: false }).range(recentOffset, recentOffset + recentLimit - 1),
    // Follow-ups of every status (scheduled/sent/failed/draft) — scheduled (sent_at null) first
    // so armed, not-yet-sent ones sort to the top, then sent by recency.
    scoped(supabaseAdmin.from("outreach_emails").select(SEND_COLS))
      .eq("kind", "followup")
      .order("sent_at", { ascending: false, nullsFirst: true }).range(followupOffset, followupOffset + followupLimit - 1),
    // Everything that got a genuine human reply — its own tab, most recent first.
    scoped(supabaseAdmin.from("outreach_emails").select(SEND_COLS))
      .not("replied_at", "is", null)
      .order("replied_at", { ascending: false }).range(repliedOffset, repliedOffset + repliedLimit - 1),
    // Wins — coverage secured, most recent first.
    scoped(supabaseAdmin.from("outreach_emails").select(SEND_COLS))
      .not("success_at", "is", null)
      .order("success_at", { ascending: false }).range(winsOffset, winsOffset + winsLimit - 1),
  ]);

  for (const r of [upcomingRes, recentRes, followupsRes, repliedRes, winsRes]) {
    if ((r as { error?: unknown }).error) throw (r as { error: unknown }).error;
  }
  const upcoming = upcomingRes.data, recent = recentRes.data, followups = followupsRes.data,
    replied = repliedRes.data, wins = winsRes.data;

  const counts: Record<string, number> = {
    scheduled: cScheduled, ready: cReady, draft: 0,
    sent: cSentInitial, failed: cFailedInitial, replied: cReplied, bounced: cBounced, success: cSuccess,
    followups: followupsTotal,
  };
  return {
    counts,
    upcoming: upcoming ?? [], upcomingTotal: cScheduled + cReady,
    recent: recent ?? [], recentTotal,
    followups: followups ?? [], followupsTotal,
    replied: replied ?? [], repliedTotal: cReplied,
    wins: wins ?? [], winsTotal: cSuccess,
  };
}

// ─── Inbox (per-person conversations) ───────────────────────────────────────────
// One row per person we've emailed, with their latest reply status + sentiment, so the inbox
// can split them into responses vs bounces/auto-replies vs awaiting. DB-driven (fast); the
// per-person thread does live IMAP.
export interface InboxPerson {
  author_id: string;
  name: string;
  publication: string;
  avatar_url: string | null;
  recipient: string;                 // their email
  sender_email: string | null;       // the mailbox we used (holds the thread)
  category: "replied" | "filtered" | "sent";
  last_at: string | null;
  replied_at: string | null;
  bounced_at: string | null;
  reply_kind: string | null;
  reply_subject: string | null;
  reply_excerpt: string | null;
  reply_sentiment: string | null;
  reply_intent: string | null;
  success_at: string | null;
  subject: string;
  unread: boolean;     // a reply arrived that this user hasn't opened yet
  dismissed: boolean;  // pushed aside by this user
  needs_reply: boolean;      // they replied and no one (AI or human) has answered since
  ai_managed: boolean;       // the AI negotiator is handling this thread
  negotiation_status: string | null;
  /** Which rail the conversation lives on. Absent means email (every pre-085 row); vendor
   *  WhatsApp threads say so and carry their wa.me link for the composer. */
  channel?: "email" | "whatsapp";
  whatsapp_url?: string | null;
  /** WhatsApp only: which team member owns this chat, and their display name. A LABEL, not a
   *  permission — see getWhatsappVendorList. Null on every unassigned chat and on email threads,
   *  which have a real per-mailbox boundary and need no such marker. */
  assigned_to?: string | null;
  assigned_label?: string | null;
  /** WhatsApp only: a person on the team vouched for `name` (095). False means it is the display
   *  string the vendor set on their own WhatsApp profile, which is fine to file a chat under and
   *  not safe to greet anyone by. */
  name_confirmed?: boolean;
}

// Scoped to ONE user's own mailbox: only conversations sent through their email address
// (sender_email = their email). Legacy env-sender sends (sender_email null) belong to the
// SMTP_USER account. This is the privacy boundary — a user only ever sees/reads their own inbox.
export async function getInboxList(userEmail: string): Promise<InboxPerson[]> {
  const isEnvOwner = !!process.env.SMTP_USER && userEmail.toLowerCase() === process.env.SMTP_USER.toLowerCase();
  let q = supabaseAdmin
    .from("outreach_emails")
    .select("author_id, sender_email, subject, status, sent_at, replied_at, bounced_at, reply_kind, reply_subject, reply_excerpt, reply_sentiment, reply_intent, success_at, ai_managed, negotiation_status, author:authors(full_name, avatar_url, domain:domains(name, host), contacts(type, value))")
    .or("status.eq.sent,replied_at.not.is.null,bounced_at.not.is.null");
  q = isEnvOwner ? q.or(`sender_email.eq.${userEmail},sender_email.is.null`) : q.eq("sender_email", userEmail);
  const { data, error } = await q
    .order("sent_at", { ascending: false, nullsFirst: false })
    .limit(3000);
  if (error) throw error; // a failed read is not an empty inbox

  // Group by author; pick the most-engaged representative (replied > bounced > latest sent).
  const rank = (r: any) => (r.replied_at ? 3 : r.bounced_at || r.reply_kind === "auto" ? 2 : 1);
  const byAuthor = new Map<string, any>();
  for (const r of data ?? []) {
    const cur = byAuthor.get(r.author_id);
    if (!cur || rank(r) > rank(cur) || (rank(r) === rank(cur) && (r.sent_at ?? "") > (cur.sent_at ?? ""))) byAuthor.set(r.author_id, r);
  }

  // Per-user read/dismiss state for these authors.
  const authorIds = [...byAuthor.keys()];
  const stateByAuthor = new Map<string, { last_seen_at: string | null; dismissed: boolean; last_reply_at: string | null }>();
  if (authorIds.length) {
    const { data: st, error: stError } = await supabaseAdmin
      .from("inbox_state").select("author_id, last_seen_at, dismissed, last_reply_at").eq("user_email", userEmail).in("author_id", authorIds);
    if (stError) throw stError; // else every thread renders unread and needs-reply
    for (const s of st ?? []) stateByAuthor.set(s.author_id, { last_seen_at: s.last_seen_at, dismissed: !!s.dismissed, last_reply_at: (s as any).last_reply_at ?? null });
  }

  // Which threads have we already answered since their reply? (a negotiation reply sent after
  // their latest reply). Used to compute "needs your reply" = replied and not yet answered.
  const lastAnswerByAuthor = new Map<string, string>();
  if (authorIds.length) {
    const { data: negs, error: negsError } = await supabaseAdmin
      .from("outreach_emails").select("author_id, sent_at").eq("kind", "negotiation").eq("status", "sent").in("author_id", authorIds);
    if (negsError) throw negsError; // else answered threads all re-flag as needing a reply
    for (const n of negs ?? []) { const cur = lastAnswerByAuthor.get((n as any).author_id); const at = (n as any).sent_at ?? ""; if (!cur || at > cur) lastAnswerByAuthor.set((n as any).author_id, at); }
  }

  const out: InboxPerson[] = [];
  for (const [author_id, r] of byAuthor) {
    const a: any = r.author ?? {};
    const mailto = (a.contacts ?? []).find((c: any) => c.type === "mailto");
    const recipient = mailto ? (mailto.value as string).replace(/^mailto:/, "") : "";
    if (!recipient) continue;
    const category: InboxPerson["category"] = r.replied_at ? "replied" : (r.bounced_at || r.reply_kind === "auto") ? "filtered" : "sent";
    const state = stateByAuthor.get(author_id);
    const unread = !!r.replied_at && (!state?.last_seen_at || r.replied_at > state.last_seen_at);
    const negStatus = (r.negotiation_status as string | null) ?? null;
    // "Answered since" = the latest of: an AI negotiation reply sent (kind='negotiation'), OR a
    // MANUAL inbox reply we recorded (inbox_state.last_reply_at — manual replies aren't
    // outreach_emails rows, so without this every hand-answered thread wrongly showed needs_reply).
    const answers = [lastAnswerByAuthor.get(author_id), state?.last_reply_at].filter(Boolean) as string[];
    const answeredAt = answers.sort().pop() ?? null;
    // A genuine (non-auto) reply that nobody has answered since, and the thread isn't closed/handed off.
    const needs_reply = category === "replied" && r.reply_kind !== "auto"
      && !["agreed", "declined", "handoff"].includes(negStatus ?? "")
      && (!answeredAt || (r.replied_at ?? "") > answeredAt);
    out.push({
      author_id, name: a.full_name ?? "Unknown", publication: a.domain?.name ?? a.domain?.host ?? "",
      avatar_url: a.avatar_url ?? null, recipient, sender_email: r.sender_email ?? null, category,
      last_at: r.replied_at ?? r.bounced_at ?? r.sent_at ?? null,
      replied_at: r.replied_at ?? null, bounced_at: r.bounced_at ?? null, reply_kind: r.reply_kind ?? null,
      reply_subject: r.reply_subject ?? null, reply_excerpt: r.reply_excerpt ?? null, reply_sentiment: r.reply_sentiment ?? null,
      reply_intent: r.reply_intent ?? null,
      success_at: r.success_at ?? null, subject: r.subject ?? "",
      unread, dismissed: !!state?.dismissed,
      needs_reply, ai_managed: !!r.ai_managed, negotiation_status: negStatus,
    });
  }
  out.sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? ""));
  return out;
}

// Mark a person's thread as seen by this user (clears unread).
export async function markInboxSeen(userEmail: string, authorId: string): Promise<void> {
  await supabaseAdmin.from("inbox_state").upsert(
    { user_email: userEmail, author_id: authorId, last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: "user_email,author_id" },
  );
}

// Record that WE replied to this person from the inbox (manual reply). Used by the "Needs your
// reply" section so a hand-answered thread stops showing up. `at` lets the thread view backfill
// from the real last-outbound IMAP date (self-heal for replies sent before this was tracked).
export async function markInboxReplied(userEmail: string, authorId: string, at?: string): Promise<void> {
  await supabaseAdmin.from("inbox_state").upsert(
    { user_email: userEmail, author_id: authorId, last_reply_at: at ?? new Date().toISOString(), updated_at: new Date().toISOString() },
    { onConflict: "user_email,author_id" },
  );
}

// Push a person aside (or bring them back) for this user.
export async function setInboxDismissed(userEmail: string, authorId: string, dismissed: boolean): Promise<void> {
  await supabaseAdmin.from("inbox_state").upsert(
    { user_email: userEmail, author_id: authorId, dismissed, updated_at: new Date().toISOString() },
    { onConflict: "user_email,author_id" },
  );
}

// Resolve a person's conversation context — SCOPED to the requesting user's own mailbox. Only
// returns a target if this user actually emailed the person through their own address, so the
// thread is always read from (and replied from) the user's own mailbox, never anyone else's.
export async function getInboxTarget(authorId: string, userEmail: string): Promise<{ recipient: string; senderEmail: string; name: string; publication: string; lastMessageId: string | null; lastSubject: string } | null> {
  const isEnvOwner = !!process.env.SMTP_USER && userEmail.toLowerCase() === process.env.SMTP_USER.toLowerCase();
  let q = supabaseAdmin
    .from("outreach_emails")
    .select("sender_email, subject, message_id, sent_at, author:authors(full_name, domain:domains(name, host), contacts(type, value))")
    .eq("author_id", authorId);
  q = isEnvOwner ? q.or(`sender_email.eq.${userEmail},sender_email.is.null`) : q.eq("sender_email", userEmail);
  const { data, error } = await q.order("sent_at", { ascending: false, nullsFirst: false }).limit(20);
  // Null below is a PRIVACY-BOUNDARY claim ("this user never emailed this person"); a read
  // failure must not be allowed to make it.
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return null; // this user never emailed this person from their own mailbox
  const a: any = rows[0].author ?? {};
  const mailto = (a.contacts ?? []).find((c: any) => c.type === "mailto");
  const recipient = mailto ? (mailto.value as string).replace(/^mailto:/, "") : "";
  if (!recipient) return null;
  const withMsgId = rows.find((r: any) => r.message_id) as any;
  return {
    recipient,
    senderEmail: userEmail, // always the requesting user's own mailbox
    name: a.full_name ?? "Unknown",
    publication: a.domain?.name ?? a.domain?.host ?? "",
    lastMessageId: withMsgId?.message_id ?? null,
    lastSubject: rows[0].subject ?? "",
  };
}

// Emails that are due to send now (scheduled and their time has passed).
export async function getDueEmails(limit = 25): Promise<Array<OutreachEmail & { recipient?: string; recipientSource?: string | null }>> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from("outreach_emails")
    // `source` rides along because the send path refuses constructed guesses — see the trust gate in
    // /api/emails/process. Without it the sender cannot tell a scraped address from a pattern guess.
    .select("*, author:authors(id, full_name, contacts(type, value, source))")
    .eq("status", "scheduled")
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((e: any) => {
    const mailto = (e.author?.contacts ?? []).find((c: any) => c.type === "mailto");
    // recipient_override (admin test-send) wins over the prospect's real address.
    const recipient = (e.recipient_override && e.recipient_override.trim()) || (mailto ? mailto.value.replace(/^mailto:/, "") : undefined);
    // An admin test-send has no prospect contact behind it, so it carries no source and is exempt.
    const recipientSource = e.recipient_override?.trim() ? null : (mailto?.source ?? null);
    return { ...e, recipient, recipientSource };
  });
}

// ─── Author-watch notifications ────────────────────────────────────────────────

export async function addAuthorWatch(userEmail: string, authorId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("author_watches")
    .upsert({ user_email: userEmail, author_id: authorId }, { onConflict: "user_email,author_id" });
  if (error) throw error;
}

export async function removeAuthorWatch(userEmail: string, authorId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("author_watches")
    .delete()
    .eq("user_email", userEmail)
    .eq("author_id", authorId);
  if (error) throw error;
}

export async function getUserWatches(userEmail: string): Promise<any[]> {
  const { data, error } = await supabaseAdmin
    .from("author_watches")
    .select("author_id, created_at, last_checked_at, author:authors(id, full_name, avatar_url, domain:domains(host, name), contacts(type, value))")
    .eq("user_email", userEmail)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// Every author watched by ANYONE, deduped — the daily check runs once per author, not once
// per watcher, then fans notifications out to everyone watching that author.
export async function getDistinctWatchedAuthors(limit = 200): Promise<any[]> {
  const { data, error } = await supabaseAdmin
    .from("author_watches")
    .select("author_id, author:authors(id, full_name, primary_domain_id, contacts(type, value), domain:domains!primary_domain_id(host))")
    .order("last_checked_at", { ascending: true, nullsFirst: true }) // stalest-checked first
    .limit(limit);
  if (error) throw error;
  const seen = new Map<string, any>();
  for (const row of data ?? []) {
    if (!seen.has(row.author_id)) seen.set(row.author_id, row.author);
  }
  return [...seen.values()].filter(Boolean);
}

export async function getWatchersOf(authorId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin.from("author_watches").select("user_email").eq("author_id", authorId);
  if (error) throw error;
  return (data ?? []).map((r) => r.user_email);
}

export async function touchWatchLastChecked(authorId: string): Promise<void> {
  await supabaseAdmin.from("author_watches").update({ last_checked_at: new Date().toISOString() }).eq("author_id", authorId);
}

// Records one notification per watching user for a newly-found article. Silently no-ops on
// the unique-constraint conflict — re-running the daily check never double-notifies.
export async function insertWatchNotification(data: { user_email: string; author_id: string; article_id: string }): Promise<void> {
  const { error } = await supabaseAdmin
    .from("author_watch_notifications")
    .upsert(data, { onConflict: "user_email,article_id", ignoreDuplicates: true });
  if (error) throw error;
}

export async function markWatchNotificationEmailed(id: string): Promise<void> {
  await supabaseAdmin.from("author_watch_notifications").update({ emailed_at: new Date().toISOString() }).eq("id", id);
}

export async function getUserNotifications(userEmail: string, limit = 100): Promise<any[]> {
  const { data, error } = await supabaseAdmin
    .from("author_watch_notifications")
    .select("id, created_at, read_at, author:authors(id, full_name), article:articles(id, title, url_canonical, published_at)")
    .eq("user_email", userEmail)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function markNotificationRead(id: string, userEmail: string): Promise<void> {
  await supabaseAdmin.from("author_watch_notifications").update({ read_at: new Date().toISOString() }).eq("id", id).eq("user_email", userEmail);
}

// ─── Internal-link opportunity backlog (whole-site sweep persistence) ───────────
export interface InternalLinkOppInput {
  source_path: string;
  target_path: string;
  source_url: string;
  source_title?: string;
  target_title?: string;
  anchor: string;
  placement: string;
  sentence?: string;
  draft_sentence?: string;
  score?: number;
  shared_terms?: string[];
}

/**
 * Upsert a sweep's opportunities, deduped on (source_path, target_path). Re-runs refresh the
 * grounding (anchor/sentence/score) and bump last_seen_at, but PRESERVE status + ticket_url so
 * an actioned/dismissed item never silently reopens. Returns how many rows were newly created.
 */
export async function saveInternalLinkOpportunities(rows: InternalLinkOppInput[]): Promise<{ saved: number; created: number }> {
  if (!rows.length) return { saved: 0, created: 0 };
  const now = new Date().toISOString();

  // Which pairs already exist? (so we can report how many are genuinely new + keep their status)
  const pairs = rows.map((r) => `${r.source_path}\u0000${r.target_path}`);
  const { data: existing } = await supabaseAdmin
    .from("internal_link_opportunities")
    .select("source_path, target_path")
    .in("source_path", [...new Set(rows.map((r) => r.source_path))]);
  const existingSet = new Set((existing ?? []).map((e: any) => `${e.source_path}\u0000${e.target_path}`));
  const created = pairs.filter((p) => !existingSet.has(p)).length;

  const payload = rows.map((r) => ({ ...r, last_seen_at: now }));
  const { error } = await supabaseAdmin
    .from("internal_link_opportunities")
    .upsert(payload, { onConflict: "source_path,target_path", ignoreDuplicates: false });
  if (error) throw error;
  return { saved: rows.length, created };
}

export async function getInternalLinkOpportunities(opts: { status?: string; limit?: number } = {}): Promise<any[]> {
  let q = supabaseAdmin
    .from("internal_link_opportunities")
    .select("*")
    .order("score", { ascending: false })
    .limit(opts.limit ?? 500);
  if (opts.status) q = q.eq("status", opts.status);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function markInternalLinkOpportunity(id: string, status: string, ticketUrl?: string): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (ticketUrl !== undefined) patch.ticket_url = ticketUrl;
  await supabaseAdmin.from("internal_link_opportunities").update(patch).eq("id", id);
}

/** How many open internal-link opportunities point AT this page (for the Rank Watcher rec). */
export async function countOpenInternalLinkOppsByTarget(targetPath: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("internal_link_opportunities")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
    .eq("target_path", targetPath);
  return count ?? 0;
}

/** Count opportunities newly discovered since `since` (for the nightly Slack digest). */
export async function countNewInternalLinkOpportunities(since: string): Promise<number> {
  const { count } = await supabaseAdmin
    .from("internal_link_opportunities")
    .select("id", { count: "exact", head: true })
    .eq("status", "open")
    .gte("first_seen_at", since);
  return count ?? 0;
}

// ─── Blog drafts (local layer in front of Strapi — see scripts/035_blog_drafts.mjs) ──────────
// Autosave writes here and ONLY here: it must succeed even when Strapi's required fields are
// still blank. Pushing to Strapi is a separate explicit action (see the sync/publish routes).
// Committed sync states only — the "…_stale" variants are derived from rev vs synced_rev by
// deriveSyncState() in src/lib/blog/state.ts, so the DB and UI can't disagree.
export type BlogSyncState = "local_only" | "synced" | "published" | "sync_failed";

export interface BlogDraft {
  id: string;
  title: string; slug: string; body: string; description: string;
  tags?: string | null; is_featured: boolean; should_index: boolean;
  canonical_tag?: string | null; youtube_video_id?: string | null;
  cover_media_id?: number | null; cover_media_url?: string | null;
  /** REQUIRED by Strapi's `resources` type. Publish is blocked without it. */
  thumbnail_media_id?: number | null; thumbnail_media_url?: string | null;
  author_id?: number | null; category_id?: number | null;
  hero_cta_text?: string | null; hero_cta_url?: string | null;
  seo_title?: string | null; seo_description?: string | null; seo_keywords?: string | null;
  /** JSON-LD, as text so a half-typed graph still saves (migration 064). Parsed and validated at the
   *  sync boundary in mapDraftToStrapi, which drops it rather than shipping a malformed graph. */
  markup_schema?: string | null;
  status: "draft" | "published";
  strapi_id?: number | null; strapi_url?: string | null;
  /** Which Strapi collection this syncs into. NULL = the blog collection. The live URL comes from
   *  the collection an entry lands in, never from canonical_tag. */
  strapi_collection?: string | null;
  /** Bumped on every accepted write; the optimistic-concurrency token. */
  rev: number;
  locale: string;
  sync_state: BlogSyncState;
  sync_error?: string | null; sync_attempted_at?: string | null;
  synced_at?: string | null; synced_rev?: number | null;
  strapi_published_at?: string | null;
  last_edited_by?: string | null;
  /** Set by the writer agent's validator: ok | flagged | failed. null = never written by the agent. */
  writer_status?: "ok" | "flagged" | "failed" | null;
  writer_qa?: unknown;
  writer_session_id?: string | null;
  cluster_id?: string | null;
  created_by?: string | null;
  created_at: string; updated_at: string; published_at?: string | null;
}

export interface BlogDraftRevision {
  id: number;
  draft_id: string;
  rev: number;
  reason: "autosave" | "manual" | "autofill" | "pre_conflict_overwrite" | "pre_sync" | "pre_publish" | "pre_restore";
  snapshot: Partial<BlogDraft>;
  created_by?: string | null;
  created_at: string;
}

export async function listBlogDrafts(status?: "draft" | "published"): Promise<BlogDraft[]> {
  let q = supabaseAdmin.from("blog_drafts").select("*").order("updated_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/**
 * Just enough of each draft to render the list.
 *
 * `select("*")` sent every draft's full BODY to a sidebar that shows title, slug and a sync badge:
 * measured at 92KB for 11 drafts, 79% of it article text nothing rendered. It grows linearly with the
 * archive, so at a hundred posts it is close to a megabyte on every page load. The editor fetches the
 * full row for the one draft you actually open.
 *
 * The extra columns beyond title/slug are the ones deriveSyncState() reads — the badge is computed,
 * not stored, so they have to come along.
 */
export type BlogDraftSummary = Pick<
  BlogDraft,
  "id" | "title" | "slug" | "status" | "rev" | "sync_state" | "synced_rev"
  | "strapi_id" | "strapi_published_at" | "sync_error" | "writer_status" | "updated_at"
  // Who or what made it. Carried into the list so a draft can be filtered by origin — an
  // externally-triggered Atlas draft is a different thing to review than one a writer started.
  | "created_by" | "created_at"
  // The fields publishReadiness() needs, so the list can show what BLOCKS a draft rather than
  // making somebody open each one to find out. Small columns; `description` is the only prose and
  // it is capped at a meta description's length.
  | "description" | "thumbnail_media_id" | "hero_cta_text" | "hero_cta_url"
  // WHERE this draft publishes, and whether its canonical contradicts that — destinationOf() and
  // canonicalConflict() in blog/destination.ts. Two small columns, and without them the list cannot
  // distinguish a draft bound for another collection from an ordinary blog post: the state that let a
  // /features/ canonical sit on a blog draft unnoticed.
  | "strapi_collection" | "canonical_tag"
>;

const DRAFT_SUMMARY_COLUMNS =
  "id, title, slug, status, rev, sync_state, synced_rev, strapi_id, strapi_published_at, sync_error, writer_status, updated_at, created_by, created_at, description, thumbnail_media_id, hero_cta_text, hero_cta_url, strapi_collection, canonical_tag";

export async function listBlogDraftSummaries(status?: "draft" | "published"): Promise<BlogDraftSummary[]> {
  let q = supabaseAdmin.from("blog_drafts").select(DRAFT_SUMMARY_COLUMNS).order("updated_at", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as BlogDraftSummary[];
}

export async function getBlogDraft(id: string): Promise<BlogDraft | null> {
  const { data, error } = await supabaseAdmin.from("blog_drafts").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function createBlogDraft(input: Partial<BlogDraft> & { created_by?: string }): Promise<BlogDraft> {
  const { data, error } = await supabaseAdmin.from("blog_drafts").insert(input).select().single();
  if (error) throw error;
  return data;
}

export async function updateBlogDraft(id: string, patch: Partial<BlogDraft>): Promise<BlogDraft> {
  const { data, error } = await supabaseAdmin
    .from("blog_drafts")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deleteBlogDraft(id: string): Promise<void> {
  const { error } = await supabaseAdmin.from("blog_drafts").delete().eq("id", id);
  if (error) throw error;
}

/**
 * The autosave write path. Applies `patch` only if the row is still at `baseRev`, so two tabs (or
 * a tab and the writer agent) can't silently clobber each other — the loser gets the current row
 * back and resolves the conflict instead of overwriting blind.
 *
 * Pass a patch that has already been through sanitizePatch() (src/lib/blog/fields.ts); this
 * function deliberately does not filter, so an unfiltered caller is a bug at the call site.
 */
export async function updateBlogDraftGuarded(
  id: string,
  patch: Partial<BlogDraft>,
  baseRev: number,
  editedBy?: string | null,
): Promise<{ row: BlogDraft } | { conflict: BlogDraft | null }> {
  const { data, error } = await supabaseAdmin
    .from("blog_drafts")
    .update({
      ...patch,
      rev: baseRev + 1,
      last_edited_by: editedBy ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("rev", baseRev)
    .select()
    .maybeSingle();
  if (error) throw error;
  // No row matched: either the id is gone or someone else advanced rev. Hand back what's there
  // now so the caller can show a real diff rather than a bare "conflict".
  if (!data) return { conflict: await getBlogDraft(id) };
  return { row: data };
}

/** Snapshot the editable fields so any save can be recovered ("start off from that point"), and
 *  so a conflict overwrite never destroys the branch it replaced. */
export async function createBlogDraftRevision(
  draftId: string,
  rev: number,
  reason: BlogDraftRevision["reason"],
  snapshot: Partial<BlogDraft>,
  createdBy?: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("blog_draft_revisions")
    .insert({ draft_id: draftId, rev, reason, snapshot, created_by: createdBy ?? null });
  if (error) throw error;
}

export async function listBlogDraftRevisions(draftId: string, limit = 20): Promise<BlogDraftRevision[]> {
  const { data, error } = await supabaseAdmin
    .from("blog_draft_revisions")
    .select("*")
    .eq("draft_id", draftId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function getBlogDraftRevision(id: number): Promise<BlogDraftRevision | null> {
  const { data, error } = await supabaseAdmin
    .from("blog_draft_revisions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** Keep the newest `keep` revisions per draft. Called right after inserting one, so the table
 *  can't grow without bound on a long editing session. */
export async function trimBlogDraftRevisions(draftId: string, keep = 20): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("blog_draft_revisions")
    .select("id")
    .eq("draft_id", draftId)
    .order("created_at", { ascending: false })
    .range(keep, keep + 200);
  if (error || !data?.length) return;
  await supabaseAdmin.from("blog_draft_revisions").delete().in("id", data.map((r) => r.id));
}

/** When did we last snapshot this draft? Used to rate-limit autosave snapshots. */
export async function lastBlogDraftRevisionAt(draftId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("blog_draft_revisions")
    .select("created_at")
    .eq("draft_id", draftId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at ?? null;
}

/** Record a successful push to Strapi as an UNPUBLISHED draft (publishedAt: null over there). */
export async function markBlogDraftSynced(
  id: string, strapiId: number, rev: number, strapiUrl?: string,
): Promise<BlogDraft> {
  return updateBlogDraft(id, {
    strapi_id: strapiId,
    strapi_url: strapiUrl,
    sync_state: "synced",
    sync_error: null,
    synced_at: new Date().toISOString(),
    synced_rev: rev,
  });
}

/** Record a failed sync WITHOUT touching any content field — the local row stays authoritative.
 *  Replaces the old behaviour of returning ok:true with a `warning` and letting the two diverge
 *  silently with nothing persisted. */
export async function markBlogDraftSyncFailed(id: string, message: string): Promise<BlogDraft> {
  return updateBlogDraft(id, {
    sync_state: "sync_failed",
    sync_error: message.slice(0, 2000),
    sync_attempted_at: new Date().toISOString(),
  });
}

/** Stamp a draft as published once publishedAt is set on the Strapi entry. */
export async function markBlogDraftPublished(
  id: string, strapiId: number, rev: number, strapiUrl?: string,
): Promise<BlogDraft> {
  const now = new Date().toISOString();
  return updateBlogDraft(id, {
    status: "published",
    strapi_id: strapiId,
    strapi_url: strapiUrl,
    sync_state: "published",
    sync_error: null,
    synced_at: now,
    synced_rev: rev,
    strapi_published_at: now,
    published_at: now,
  });
}

/** Reverse of the above — the Strapi entry still exists, it just isn't live any more. */
export async function markBlogDraftUnpublished(id: string): Promise<BlogDraft> {
  return updateBlogDraft(id, {
    status: "draft",
    sync_state: "synced",
    strapi_published_at: null,
    published_at: null,
  });
}

/** Is this slug already taken by a different local draft? Strapi's slug is a unique `uid`, and
 *  uid uniqueness is NOT relaxed for drafts, so a collision fails at sync time — check first. */
export async function blogSlugTaken(slug: string, exceptId?: string): Promise<boolean> {
  let q = supabaseAdmin.from("blog_drafts").select("id").eq("slug", slug).limit(1);
  if (exceptId) q = q.neq("id", exceptId);
  const { data, error } = await q;
  if (error) throw error; // a collision guard that cannot read is not a pass — publishing onto a live URL is the cost
  return !!data?.length;
}

// ─── Writer voices (brand styles for the AI writing agent — see scripts/044_writer_voices.mjs) ──
// One row = one selectable voice. The prompt-bearing columns render into the agent's cached system
// prompt, so `prompt_revision` is bumped only when one of those actually changes — see
// PROMPT_BEARING_FIELDS in src/lib/writer/voice.ts. Renaming a voice must not cost a cache miss.

export interface WriterVoice {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  is_default: boolean;
  tone_doc: string;
  banned_words: string[];
  banned_phrases: string[];
  workflow_rules: string;
  /** [{url, category, description}] — the internal-link database for this brand. */
  sitemap_links: unknown;
  brand_name?: string | null;
  default_word_count: number;
  default_cta_text?: string | null;
  default_cta_url?: string | null;
  allowed_link_hosts: string[];
  archived: boolean;
  prompt_revision: number;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

/** Everything a human may edit. Anything outside this is server-owned (id, prompt_revision,
 *  timestamps) — same allow-list discipline as blog drafts, for the same reason. */
const WRITER_VOICE_EDITABLE = [
  "name", "description", "tone_doc", "banned_words", "banned_phrases", "workflow_rules",
  "sitemap_links", "brand_name", "default_word_count", "default_cta_text", "default_cta_url",
  "allowed_link_hosts", "archived",
] as const;

/** Changing any of these alters the cached system prompt, so it must bump prompt_revision. */
const WRITER_VOICE_PROMPT_BEARING = new Set<string>([
  "tone_doc", "banned_words", "banned_phrases", "workflow_rules", "sitemap_links", "brand_name",
  "default_word_count", "default_cta_text", "default_cta_url", "allowed_link_hosts",
]);

export async function listWriterVoices(includeArchived = false): Promise<WriterVoice[]> {
  let q = supabaseAdmin.from("writer_voices").select("*")
    .order("is_default", { ascending: false }).order("name");
  if (!includeArchived) q = q.eq("archived", false);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function getWriterVoice(id: string): Promise<WriterVoice | null> {
  const { data, error } = await supabaseAdmin
    .from("writer_voices").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function getWriterVoiceBySlug(slug: string): Promise<WriterVoice | null> {
  const { data, error } = await supabaseAdmin
    .from("writer_voices").select("*").eq("slug", slug).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** The voice used when the caller doesn't pick one. Falls back to any non-archived voice so a
 *  mis-seeded database degrades to "some voice" rather than to a crash. */
export async function getDefaultWriterVoice(): Promise<WriterVoice | null> {
  const { data } = await supabaseAdmin
    .from("writer_voices").select("*").eq("is_default", true).eq("archived", false).maybeSingle();
  if (data) return data;
  const { data: any1 } = await supabaseAdmin
    .from("writer_voices").select("*").eq("archived", false).limit(1).maybeSingle();
  return any1 ?? null;
}

export async function createWriterVoice(
  input: Partial<WriterVoice> & { slug: string; name: string },
): Promise<WriterVoice> {
  const { data, error } = await supabaseAdmin
    .from("writer_voices").insert(input).select().single();
  if (error) throw error;
  return data;
}

/**
 * Update a voice from an arbitrary request body. Unknown keys are dropped rather than passed to
 * Postgres, and `prompt_revision` advances only when a prompt-bearing column actually changed —
 * a rename or a description tweak leaves the cache intact.
 */
export async function saveWriterVoice(
  id: string, body: Record<string, unknown>,
): Promise<WriterVoice | null> {
  const current = await getWriterVoice(id);
  if (!current) return null;

  const patch: Record<string, unknown> = {};
  let bump = false;
  for (const key of WRITER_VOICE_EDITABLE) {
    if (!(key in body)) continue;
    let value = body[key];
    // Coerce the array columns so a comma-separated string from a textarea still works.
    if (key === "banned_words" || key === "banned_phrases" || key === "allowed_link_hosts") {
      if (typeof value === "string") {
        value = value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      }
      if (!Array.isArray(value)) continue;
    }
    if (key === "default_word_count") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 200) continue;
      value = Math.round(n);
    }
    patch[key] = value;
    if (WRITER_VOICE_PROMPT_BEARING.has(key)
        && JSON.stringify(value) !== JSON.stringify((current as any)[key])) {
      bump = true;
    }
  }
  if (Object.keys(patch).length === 0) return current;

  const { data, error } = await supabaseAdmin
    .from("writer_voices")
    .update({
      ...patch,
      ...(bump ? { prompt_revision: current.prompt_revision + 1 } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Move the default flag. Two statements because a partial unique index enforces one default, so
 *  the old one must be cleared before the new one is set. */
export async function setDefaultWriterVoice(id: string): Promise<void> {
  await supabaseAdmin.from("writer_voices").update({ is_default: false }).eq("is_default", true);
  const { error } = await supabaseAdmin
    .from("writer_voices").update({ is_default: true }).eq("id", id);
  if (error) throw error;
}

// ─── Writer sessions (the AI writing agent's chat state — see scripts/045_writer_sessions.mjs) ──
// `phase` is the single source of truth for workflow position; only the application advances it
// (in response to a tool call, or a human's POST to /approve), never the model's prose.

export type WriterPhase =
  | "gathering" | "researching" | "outline_pending" | "approved"
  | "writing" | "validating" | "done" | "failed";

export interface WriterBrief {
  primary_keyword: string;
  topic: string;
  page_type: "blog" | "landing";
  /** A key from src/lib/blog/pageTypes.ts — the editorial shape, distinct from `page_type` above,
   *  which only says which CMS collection the thing lands in. */
  blog_page_type?: string;
  /** Practitioner posts only: the role from src/lib/blog/practitioner.ts writing the piece. */
  persona?: string;
  /**
   * True when the article's subject is a model we do NOT run.
   *
   * Covering these is deliberate (user value, domain authority). The flag exists so the WRITING can
   * honour the one obligation that comes with it: say the boundary plainly and never imply the model
   * runs in ImagineArt. See src/lib/blog/brand.ts.
   */
  not_hosted?: boolean;
  /**
   * ImagineArt videos that match this subject, resolved ONCE when the request is made.
   *
   * Resolved here rather than in the prompt builder because that is synchronous and this needs a
   * network read, and resolved once rather than per turn because the channel feed does not change
   * during a run and eight identical fetches would be waste. Empty array = looked and found nothing,
   * which is different from undefined = never looked.
   */
  video_embeds?: Array<{ id: string; title: string; url: string; published: string }>;
  word_count: number;
  negative_keywords?: string[];
  secondary_keywords?: string[];
  cta_text?: string | null;
  cta_url?: string | null;
  experiences?: string[];
  competitor_urls?: string[];
  /** Left over from the removed clusters feature: nothing populates this any more. It survives
   *  only because propose_outline and the finalize provenance gate still spread it into their
   *  set of valid internal-link targets, where an absent value is a no-op. */
  cluster_siblings?: string[];
  /** Raw material the piece is written FROM — a transcript, notes, pasted markdown — when the
   *  request arrived over the API rather than through the composer. Stored on the brief so a resumed
   *  run can tell whether it has already been handed to the model, and so anyone opening the session
   *  later can see what the article was actually built from. */
  source_material?: string;
  /** A hero image the caller supplied (Atlas sends the source video's poster frame). Lives on the
   *  brief because the worker that uses it is a different invocation from the one that received it. */
  hero_image_url?: string;
}

export interface WriterOutlineSection {
  level: "h2" | "h3";
  heading: string;
  target_words?: number;
  is_faq?: boolean;
}

export interface WriterOutline {
  search_intent: string;
  h1: string;
  sections: WriterOutlineSection[];
  /** `section_index` is the 0-based position in `sections`. Referenced by index rather than by
   *  heading text because fuzzy-matching a free-text section name against the heading silently
   *  failed to match, and the writing directive then told the model no sources were assigned —
   *  producing complete articles with zero citations. */
  source_plan: Array<{ url: string; insight: string; anchor_text: string; section_index: number }>;
  link_plan: Array<{ url: string; anchor_text: string; section_index: number }>;
}

export interface WriterSession {
  id: string;
  voice_id: string | null;
  voice_revision: number | null;
  kind: "single" | "cluster_member";
  phase: WriterPhase;
  brief: Partial<WriterBrief>;
  /** The provenance ledger: everything a research tool actually returned this session. The
   *  validator checks the finished article against it, so a citation, statistic or question heading
   *  that is not traceable here is treated as invented. */
  research: {
    sources?: Record<string, unknown>;
    keyword_rows?: unknown[];
    /** Real People Also Ask questions from serp_analysis. */
    paa?: string[];
    /** Real related searches from serp_analysis. */
    related?: string[];
  };
  /** Operator instructions that are NOT negotiable (migration 063). Distinct from `brief.topic`, which
   *  the model may interpret: this is rendered into the per-turn directive verbatim, every turn, so it
   *  cannot decay out of context the way a first-message instruction does. */
  must_follow?: string | null;
  /** URLs the operator required the agent to read. `competitor_urls` used to be stored and never read
   *  back by anything, which is why supplied links appeared to be ignored — they were. */
  required_sources?: string[];
  /** Of those, the ones actually fetched. Lets the gate state a fact rather than nag. */
  sources_read?: string[];
  outline: WriterOutline | null;
  outline_approved_at?: string | null;
  outline_approved_by?: string | null;
  section_cursor: number;
  /** Written sections keyed by outline index ("0", "1", ...). blog_drafts.body is REBUILT from this
   *  in index order on every submit, so a repeated or out-of-order submit_section is idempotent and
   *  the validator's repair loop can replace one section without touching the others. */
  sections: Record<string, string>;
  draft_id: string | null;
  cluster_id: string | null;
  usage: Record<string, unknown>;
  error?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface WriterMessage {
  id: number;
  session_id: string;
  seq: number;
  role: "user" | "assistant";
  /** Anthropic.MessageParam["content"] — an array of raw content blocks, stored verbatim. */
  blocks: unknown[];
  created_at: string;
}

export async function createWriterSession(
  input: Partial<WriterSession> & { created_by?: string },
): Promise<WriterSession> {
  const { data, error } = await supabaseAdmin.from("writer_sessions").insert(input).select().single();
  if (error) throw error;
  return data;
}

export async function getWriterSession(id: string): Promise<WriterSession | null> {
  const { data, error } = await supabaseAdmin.from("writer_sessions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function listWriterSessions(clusterId?: string): Promise<WriterSession[]> {
  let q = supabaseAdmin.from("writer_sessions").select("*").order("created_at", { ascending: false });
  if (clusterId) q = q.eq("cluster_id", clusterId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/**
 * Just enough of each writer session to render the session list.
 *
 * `select("*")` on this table is expensive in a way that is easy to miss: every row carries the full
 * `research` ledger (one real session held 49 sources with snippets), the `outline`, and `sections` —
 * which is the entire article text. Measured at 98KB for three sessions, for a list that shows a
 * keyword and a phase.
 */
export type WriterSessionSummary = Pick<
  WriterSession, "id" | "kind" | "phase" | "brief" | "draft_id" | "cluster_id" | "created_at" | "voice_id"
>;

export async function listWriterSessionSummaries(clusterId?: string): Promise<WriterSessionSummary[]> {
  let q = supabaseAdmin
    .from("writer_sessions")
    // voice_id is a uuid, not the article text this Pick exists to avoid, and without it the list
    // cannot say which voice a session is in. Every row reads "Untitled brief" until a keyword is
    // saved, so the voice is the only thing distinguishing one from another.
    .select("id, kind, phase, brief, draft_id, cluster_id, created_at, voice_id")
    .order("created_at", { ascending: false });
  if (clusterId) q = q.eq("cluster_id", clusterId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as WriterSessionSummary[];
}

/** The one function every phase transition goes through, so "phase only moves forward via the
 *  application" is enforced in one place rather than by convention at each call site. */
export async function updateWriterSession(id: string, patch: Partial<WriterSession>): Promise<WriterSession> {
  const { data, error } = await supabaseAdmin
    .from("writer_sessions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Merge new usage into the running total rather than overwriting, so per-session cost is
 *  cumulative across every turn and every section. */
export async function accumulateWriterUsage(
  id: string,
  delta: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
): Promise<void> {
  const current = await getWriterSession(id);
  if (!current) return;
  const usage = { ...(current.usage as Record<string, number>) };
  for (const [k, v] of Object.entries(delta)) usage[k] = (usage[k] ?? 0) + (v ?? 0);
  const { error } = await supabaseAdmin.from("writer_sessions").update({ usage }).eq("id", id);
  if (error) throw error;
}

export async function appendWriterMessage(
  sessionId: string, role: "user" | "assistant", blocks: unknown[],
): Promise<WriterMessage> {
  const { data: last } = await supabaseAdmin
    .from("writer_messages").select("seq").eq("session_id", sessionId).order("seq", { ascending: false }).limit(1).maybeSingle();
  const seq = (last?.seq ?? -1) + 1;
  const { data, error } = await supabaseAdmin
    .from("writer_messages").insert({ session_id: sessionId, seq, role, blocks }).select().single();
  if (error) throw error;
  return data;
}

export async function listWriterMessages(sessionId: string): Promise<WriterMessage[]> {
  const { data, error } = await supabaseAdmin
    .from("writer_messages").select("*").eq("session_id", sessionId).order("seq", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// ─── Writer clusters (pillar + supporting posts, planned once, written unattended) ─────────────

/** One post in a cluster plan. Mirrors ClusterPlanItem in src/lib/writer/cluster.ts, which owns the
 *  planning logic; this is the row-level shape of the `plan` jsonb column.
 *  `slug` and `links_to` are absent until the plan is approved — slugs are minted at that point so
 *  every sibling URL is known before any article is written. */
export interface WriterClusterPlanItem {
  keyword: string;
  title: string;
  angle: string;
  headings: string[];
  word_count: number;
  /** Measured Search Console demand behind this choice, kept so the plan stays auditable. */
  impressions: number;
  position: number;
  slug?: string;
  links_to?: string[];
}

export interface WriterClusterPlan {
  pillar: WriterClusterPlanItem;
  supporting: WriterClusterPlanItem[];
  /** The exact GSC rows the plan was built from. */
  evidence: Array<{ keyword: string; impressions: number; clicks: number; position: number; opportunity: number }>;
  notes: string[];
}

export interface WriterCluster {
  id: string;
  voice_id: string | null;
  pillar_keyword: string;
  title: string | null;
  keyword_source: unknown;
  plan: WriterClusterPlan | null;
  status: "planning" | "plan_pending" | "approved" | "running" | "done" | "partial" | "failed";
  approved_at?: string | null;
  approved_by?: string | null;
  total: number;
  done: number;
  failed: number;
  cursor: number;
  error?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export async function createWriterCluster(
  input: Partial<WriterCluster> & { pillar_keyword: string; created_by?: string },
): Promise<WriterCluster> {
  const { data, error } = await supabaseAdmin.from("writer_clusters").insert(input).select().single();
  if (error) throw error;
  return data;
}

export async function getWriterCluster(id: string): Promise<WriterCluster | null> {
  const { data, error } = await supabaseAdmin.from("writer_clusters").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function listWriterClusters(): Promise<WriterCluster[]> {
  const { data, error } = await supabaseAdmin.from("writer_clusters").select("*").order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function updateWriterCluster(id: string, patch: Partial<WriterCluster>): Promise<WriterCluster> {
  const { data, error } = await supabaseAdmin
    .from("writer_clusters").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select().single();
  if (error) throw error;
  return data;
}

// ─── GEO Citation history (which AI engine surfaced an answer, per prompt, over time) ──────────
// A single scan's "0% answered" is noise, not a verdict — Google's AI Overview in particular is
// confirmed intermittent per query, drifting over hours with no per-request randomness. Logging
// every check turns that noise into a trend ("answered 3/10 of the last checks").

export interface GeoCheckRow {
  prompt: string;
  engine: string;
  answered: boolean;
  brandMentioned: boolean;
  surface?: string;
  citedDomains: string[];
}

/** Best-effort log of one scan's results — never throws (history is a nice-to-have, not load-bearing). */
export async function logGeoChecks(rows: GeoCheckRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabaseAdmin.from("geo_checks").insert(
    rows.map((r) => ({
      prompt: r.prompt,
      engine: r.engine,
      answered: r.answered,
      brand_mentioned: r.brandMentioned,
      surface: r.surface ?? null,
      cited_domains: r.citedDomains,
    })),
  );
  if (error) console.error("geo: failed to log check history", error.message);
}

export interface GeoHitRate {
  checked: number;
  answered: number;
}

/**
 * Hit-rate over the last `limit` logged checks for each (prompt, engine) pair — including the
 * current run's own row if it was already logged, so "last N" always includes "just now".
 * Returns a map keyed by `${prompt}::${engine}`. Best-effort: returns {} on any failure.
 */
export async function getGeoHitRates(
  pairs: { prompt: string; engine: string }[],
  limit = 10,
): Promise<Record<string, GeoHitRate>> {
  const out: Record<string, GeoHitRate> = {};
  if (pairs.length === 0) return out;
  const uniquePrompts = [...new Set(pairs.map((p) => p.prompt))];
  const uniqueEngines = [...new Set(pairs.map((p) => p.engine))];
  const { data, error } = await supabaseAdmin
    .from("geo_checks")
    .select("prompt, engine, answered, run_at")
    .in("prompt", uniquePrompts)
    .in("engine", uniqueEngines)
    .order("run_at", { ascending: false })
    .limit(500);
  if (error || !data) return out;

  const byPair = new Map<string, { answered: boolean }[]>();
  for (const row of data) {
    const key = `${row.prompt}::${row.engine}`;
    const list = byPair.get(key) ?? [];
    if (list.length < limit) list.push({ answered: row.answered });
    byPair.set(key, list);
  }
  for (const { prompt, engine } of pairs) {
    const key = `${prompt}::${engine}`;
    const list = byPair.get(key) ?? [];
    out[key] = { checked: list.length, answered: list.filter((r) => r.answered).length };
  }
  return out;
}

// ─── Hermes agent (in-app conversational operator — migration 068) ─────────────────────────────

export type HermesSessionStatus = "active" | "done" | "failed";

export interface HermesSession {
  id: string;
  user_email: string;
  title: string | null;
  status: HermesSessionStatus;
  usage: Record<string, unknown>;
  /**
   * Which Claude model this conversation runs on. Null means the chat default (CHAT_MODEL —
   * Sonnet 5 since Opus left the picker for cost).
   *
   * Per-SESSION rather than per-user or per-turn, because prompt caching is keyed on the model:
   * every turn of one conversation should hit the same cache, and a per-turn switch would pay the
   * cache-write cost again on each flip. Stored as the raw id and resolved through
   * resolveChatModel() at call time, so an id retired between sessions (including "claude-opus-5")
   * degrades to the default instead of erroring every turn of an old conversation.
   */
  model: string | null;
  created_at: string;
  updated_at: string;
}

export interface HermesMessage {
  id: number;
  session_id: string;
  seq: number;
  role: "user" | "assistant";
  /** Anthropic.MessageParam["content"] — raw content blocks, stored verbatim (writer_messages contract). */
  blocks: unknown[];
  created_at: string;
}

/** The irreversible actions the agent may PROPOSE but never execute. Execution happens in
 *  src/lib/hermes/confirm.ts after a human clicks the card; adding a kind here without a dispatch
 *  entry there produces a card whose Confirm button fails, so keep the two in sync. */
export type HermesActionKind =
  | "send_emails" | "send_reply" | "publish_draft" | "unpublish_draft" | "sync_draft"
  | "open_pr" | "create_ticket" | "post_slack"
  | "mark_payment" | "request_payment" | "set_policy" | "fix_404s";

export type HermesActionStatus = "proposed" | "confirmed" | "executed" | "declined" | "expired" | "failed";

export interface HermesAction {
  id: string;
  session_id: string;
  kind: HermesActionKind;
  summary: string;
  params: Record<string, unknown>;
  status: HermesActionStatus;
  proposed_at: string;
  resolved_at: string | null;
  /** The human who clicked. Never the model — that attribution is the audit trail's whole point. */
  resolved_by: string | null;
  result: Record<string, unknown> | null;
}

export async function createHermesSession(userEmail: string, title?: string, model?: string | null): Promise<HermesSession> {
  const { data, error } = await supabaseAdmin
    .from("hermes_sessions")
    // `model` is only written when explicitly asked for. Storing the resolved default instead would
    // pin every conversation ever started to whatever the default meant on the day it was created,
    // and the fallback in resolveChatModel() exists precisely so null keeps tracking the current one.
    .insert({ user_email: userEmail, title: title ?? null, ...(model ? { model } : {}) })
    .select().single();
  if (error) throw error;
  return data;
}

/**
 * Delete one conversation, and only if it is the caller's.
 *
 * Scoped by email in the WHERE clause rather than checked first and deleted second: a read-then-write
 * can be raced, and more importantly a caller who is not the owner should not be able to learn that the
 * id exists. A miss and a refusal look identical from outside, which is the correct amount of
 * information to leak about somebody else's chat.
 *
 * Messages go with it. `hermes_messages` has no ON DELETE CASCADE, so leaving them would orphan every
 * turn — invisible in the UI, still counted by anything that aggregates the table, and impossible to
 * attribute once the session row naming the owner is gone. Deleted first, so a failure halfway leaves
 * a session with missing turns (recoverable, visible) rather than messages nobody owns.
 */
export async function deleteHermesSession(id: string, userEmail: string): Promise<boolean> {
  const { data: owned, error: findErr } = await supabaseAdmin
    .from("hermes_sessions").select("id").eq("id", id).eq("user_email", userEmail).maybeSingle();
  if (findErr) throw findErr;
  if (!owned) return false;

  const { error: msgErr } = await supabaseAdmin.from("hermes_messages").delete().eq("session_id", id);
  if (msgErr) throw msgErr;

  const { error } = await supabaseAdmin
    .from("hermes_sessions").delete().eq("id", id).eq("user_email", userEmail);
  if (error) throw error;
  return true;
}

export async function getHermesSession(id: string): Promise<HermesSession | null> {
  const { data, error } = await supabaseAdmin.from("hermes_sessions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/** Sessions are per-person: the list only ever shows your own. Messages are small (no article
 *  bodies here), but the list still selects columns explicitly so a future jsonb column can't
 *  quietly bloat it the way writer_sessions' select("*") did. */
export async function listHermesSessions(userEmail: string, limit = 30): Promise<HermesSession[]> {
  const { data, error } = await supabaseAdmin
    .from("hermes_sessions")
    .select("id, user_email, title, status, usage, model, created_at, updated_at")
    .eq("user_email", userEmail)
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/**
 * Everyone who has ever held a Summer conversation, with how many and when they last spoke.
 *
 * Superuser only — the route enforces that, not this function. Kept as its own query rather than a
 * flag on listHermesSessions because the two answer different questions, and a boolean that widens
 * a per-user read into an everyone read is exactly the kind of parameter that gets passed `true` by
 * accident from a route that meant something else.
 */
export async function listHermesUsers(): Promise<
  { user_email: string; sessions: number; last_active: string }[]
> {
  const { data, error } = await supabaseAdmin
    .from("hermes_sessions")
    .select("user_email, updated_at")
    .order("updated_at", { ascending: false })
    .limit(2000);
  if (error) throw error;
  const by = new Map<string, { user_email: string; sessions: number; last_active: string }>();
  for (const row of (data ?? []) as { user_email: string; updated_at: string }[]) {
    const seen = by.get(row.user_email);
    // Rows arrive newest first, so the first sighting of an email is its latest activity.
    if (seen) seen.sessions++;
    else by.set(row.user_email, { user_email: row.user_email, sessions: 1, last_active: row.updated_at });
  }
  return [...by.values()].sort((a, b) => b.last_active.localeCompare(a.last_active));
}

export interface HermesSearchHit {
  session_id: string;
  title: string | null;
  project_id: string | null;
  updated_at: string;
  /** The term appears in the conversation's title, not just its body. Ranked first. */
  in_title: boolean;
  /** How many messages mention it — the tiebreaker after title. */
  hits: number;
  /** First matching message, one line, ~240 chars. Null when only the title matched. */
  snippet: string | null;
}

/**
 * Search a user's conversations by title AND message content.
 *
 * Delegates to the `hermes_search` Postgres function (scripts/069) because this ranks a union
 * across two tables — a title match must outrank a passing mention, and doing that client-side
 * would mean two round trips and a merge. Substring matching, not full-text: people search these
 * by fragment ("genai", "nano-banana") and a stemmer mangles exactly those tokens.
 */
export async function searchHermesSessions(
  userEmail: string,
  term: string,
  limit = 20,
): Promise<HermesSearchHit[]> {
  const q = term.trim();
  // One character matches nearly everything and makes the palette flash noise on the first
  // keystroke. The caller debounces; this is the floor.
  if (q.length < 2) return [];
  const { data, error } = await supabaseAdmin.rpc("hermes_search", {
    p_user_email: userEmail,
    p_term: q,
    p_limit: limit,
  });
  if (error) throw error;
  return (data ?? []) as HermesSearchHit[];
}

export async function updateHermesSession(id: string, patch: Partial<HermesSession>): Promise<HermesSession> {
  const { data, error } = await supabaseAdmin
    .from("hermes_sessions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Merge new usage into the running total rather than overwriting — same shape as
 *  accumulateWriterUsage, so a runaway session is visible before the bill. */
export async function accumulateHermesUsage(
  id: string,
  delta: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
): Promise<void> {
  const current = await getHermesSession(id);
  if (!current) return;
  const usage = { ...(current.usage as Record<string, number>) };
  for (const [k, v] of Object.entries(delta)) usage[k] = (usage[k] ?? 0) + (v ?? 0);
  const { error } = await supabaseAdmin.from("hermes_sessions").update({ usage }).eq("id", id);
  if (error) throw error;
}

export async function appendHermesMessage(
  sessionId: string, role: "user" | "assistant", blocks: unknown[],
): Promise<HermesMessage> {
  const { data: last } = await supabaseAdmin
    .from("hermes_messages").select("seq").eq("session_id", sessionId).order("seq", { ascending: false }).limit(1).maybeSingle();
  const seq = (last?.seq ?? -1) + 1;
  const { data, error } = await supabaseAdmin
    .from("hermes_messages").insert({ session_id: sessionId, seq, role, blocks }).select().single();
  if (error) throw error;
  return data;
}

export async function listHermesMessages(sessionId: string): Promise<HermesMessage[]> {
  const { data, error } = await supabaseAdmin
    .from("hermes_messages").select("*").eq("session_id", sessionId).order("seq", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function createHermesAction(input: {
  session_id: string;
  kind: HermesActionKind;
  summary: string;
  params: Record<string, unknown>;
}): Promise<HermesAction> {
  const { data, error } = await supabaseAdmin.from("hermes_actions").insert(input).select().single();
  if (error) throw error;
  return data;
}

export async function getHermesAction(id: string): Promise<HermesAction | null> {
  const { data, error } = await supabaseAdmin.from("hermes_actions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * The ONLY way an action leaves `proposed`. The status filter in the WHERE clause is the guard
 * against a double-click or a stale card: the second resolve matches zero rows and returns null
 * rather than re-executing. (Same defence as the backlink pitch editor's `sent_at IS NULL`.)
 */
export async function resolveHermesAction(
  id: string,
  status: Extract<HermesActionStatus, "confirmed" | "executed" | "declined" | "expired" | "failed">,
  resolvedBy: string | null,
  result?: Record<string, unknown>,
): Promise<HermesAction | null> {
  const fromStatuses: HermesActionStatus[] =
    status === "executed" || status === "failed" ? ["confirmed"] : ["proposed"];
  const { data, error } = await supabaseAdmin
    .from("hermes_actions")
    .update({
      status,
      resolved_at: new Date().toISOString(),
      ...(resolvedBy ? { resolved_by: resolvedBy } : {}),
      ...(result !== undefined ? { result } : {}),
    })
    .eq("id", id)
    .in("status", fromStatuses)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function listPendingHermesActions(sessionId: string): Promise<HermesAction[]> {
  const { data, error } = await supabaseAdmin
    .from("hermes_actions")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "proposed")
    .order("proposed_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function listHermesActions(sessionId: string): Promise<HermesAction[]> {
  const { data, error } = await supabaseAdmin
    .from("hermes_actions")
    .select("*")
    .eq("session_id", sessionId)
    .order("proposed_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/** Actions resolved after `sinceIso` — how the next turn learns what a human clicked between
 *  messages. Injected into the turn directive rather than appended as their own message, because
 *  two consecutive user-role messages is an API shape this loop never produces. */
export async function listResolvedHermesActionsSince(sessionId: string, sinceIso: string): Promise<HermesAction[]> {
  const { data, error } = await supabaseAdmin
    .from("hermes_actions")
    .select("*")
    .eq("session_id", sessionId)
    .in("status", ["executed", "failed", "declined", "expired"])
    .gt("resolved_at", sinceIso)
    .order("resolved_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// ─── Hermes projects (folders over conversations — migration 069) ──────────────────────────────

export interface HermesProject {
  id: string;
  user_email: string;
  name: string;
  /** A THEME TOKEN NAME ("chart-1"…"chart-5"), never a hex — migration 069's rule. The UI turns it
   *  into a class, and a literal colour stored here would bypass the light/dark pair the token
   *  resolves to, so a project picked in dark mode would glow in light mode. */
  color: string | null;
  created_at: string;
  updated_at: string;
}

/** A session row with its shelf. `project_id` is not on `HermesSession` because `listHermesSessions`
 *  predates projects and still names its columns one by one; widening that select from under its
 *  callers is a bigger change than this feature needs, so the rail gets the mapping from
 *  `listHermesProjectAssignments` below and only the writes return the column. */
export type HermesSessionWithProject = HermesSession & { project_id: string | null };

/**
 * A user's projects, newest-touched first.
 *
 * The email is a required argument for exactly the reason `searchHermesSessions` takes one: there
 * must be no code path where a missing identity quietly reads across the table.
 *
 * Note what `updated_at` means here. `hermes_projects` has no trigger on it, so it moves when
 * `updateHermesProject` sets it and never otherwise — a busy project reads as untouched since the
 * day it was named. This ordering is therefore the fallback, not the answer; the rail orders on
 * last CONVERSATION activity (see `listHermesProjectAssignments`) and uses this only for a project
 * that has no conversations to speak for it.
 */
export async function listHermesProjects(userEmail: string): Promise<HermesProject[]> {
  const { data, error } = await supabaseAdmin
    .from("hermes_projects")
    .select("id, user_email, name, color, created_at, updated_at")
    .eq("user_email", userEmail)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/** Unique on (user_email, lower(name)), so a same-name collision throws with `.code === "23505"`
 *  and the route turns that into a 409. Scoped per person: two people may each keep a "Launches". */
export async function createHermesProject(
  userEmail: string,
  name: string,
  color: string | null = null,
): Promise<HermesProject> {
  const { data, error } = await supabaseAdmin
    .from("hermes_projects")
    .insert({ user_email: userEmail, name, color })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Rename and/or recolour.
 *
 * Ownership is enforced IN the update, not by a read before it: an id belonging to someone else
 * matches no row and comes back null, so there is no window between checking and writing. The patch
 * is copied field by field rather than spread, because it arrives from a request body and spreading
 * would let a caller set `user_email` alongside the name. `updated_at` is stamped by hand — the
 * table has no trigger.
 */
export async function updateHermesProject(
  id: string,
  userEmail: string,
  patch: { name?: string; color?: string | null },
): Promise<HermesProject | null> {
  const fields: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) fields.name = patch.name;
  if (patch.color !== undefined) fields.color = patch.color;
  const { data, error } = await supabaseAdmin
    .from("hermes_projects")
    .update(fields)
    .eq("id", id)
    .eq("user_email", userEmail)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * Delete the project. Never the conversations.
 *
 * `hermes_sessions.project_id` is ON DELETE SET NULL, so the chats simply land back in the unfiled
 * bucket — this is a shelf being removed, not a folder being emptied. The count is taken BEFORE the
 * delete (afterwards there is nothing left pointing at the row) and returned so the confirmation
 * copy can name the real number instead of hedging.
 */
export async function deleteHermesProject(
  id: string,
  userEmail: string,
): Promise<{ deleted: boolean; released: number }> {
  const { count } = await supabaseAdmin
    .from("hermes_sessions")
    .select("id", { count: "exact", head: true })
    .eq("user_email", userEmail)
    .eq("project_id", id);
  const { data, error } = await supabaseAdmin
    .from("hermes_projects")
    .delete()
    .eq("id", id)
    .eq("user_email", userEmail)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return { deleted: Boolean(data), released: data ? (count ?? 0) : 0 };
}

/**
 * File a conversation, move it, or unfile it — one write, because they are one write. `null` means
 * "in no project", which is a destination and not merely a starting state: deleting a project sends
 * chats back here too.
 *
 * Deliberately NOT routed through `updateHermesSession`, for two concrete reasons. That function
 * spreads its patch (so a route forwarding a body becomes mass-assignment over `user_email`,
 * `status` and `usage`), and it stamps `updated_at` on every call. Filing a chat is tidying, not
 * talking to it — bumping the timestamp would jump the chat to the top of a rail ordered by
 * conversation recency. This writes the one column and leaves recency alone.
 *
 * Both halves of ownership are checked. The `.eq` on user_email covers the session; the lookup
 * above covers the target project, which nothing else does — the foreign key is perfectly happy to
 * point one person's chat at another person's project, and this table has more than one person in
 * it.
 */
export async function setHermesSessionProject(
  sessionId: string,
  userEmail: string,
  projectId: string | null,
): Promise<HermesSessionWithProject | null> {
  if (projectId) {
    const { data: project, error: projectError } = await supabaseAdmin
      .from("hermes_projects")
      .select("id")
      .eq("id", projectId)
      .eq("user_email", userEmail)
      .maybeSingle();
    if (projectError) throw projectError;
    if (!project) return null;
  }
  const { data, error } = await supabaseAdmin
    .from("hermes_sessions")
    .update({ project_id: projectId })
    .eq("id", sessionId)
    .eq("user_email", userEmail)
    .select("id, user_email, title, status, usage, project_id, created_at, updated_at")
    .maybeSingle();
  if (error) throw error;
  return (data as HermesSessionWithProject | null) ?? null;
}

export interface HermesProjectAssignments {
  /** session id → project id, for every FILED conversation. Unfiled chats are absent, not null:
   *  the caller already knows about the ones it is holding, and absence is the same answer. */
  bySession: Record<string, string>;
  /** project id → the `updated_at` of its most recent conversation. Absent for an empty project. */
  lastActivity: Record<string, string>;
}

/**
 * The whole mapping in one round trip.
 *
 * The obvious alternative — a head-count per project — is one round trip per project to answer a
 * question a single 20-row read already contains, and it still would not give the rail what it
 * actually needs, which is per-session placement.
 *
 * `lastActivity` rides along because `hermes_projects.updated_at` is not a proxy for activity (see
 * `listHermesProjects`). It is computed over ALL of a user's sessions rather than the page of them
 * the rail happens to be showing, so a project whose chats have all fallen off that page still
 * sorts by when it was last used instead of dropping to the bottom.
 *
 * Unbounded on purpose, subject to the same 1000-row REST ceiling as every other plain select here;
 * this is three narrow columns over one person's sessions.
 */
export async function listHermesProjectAssignments(userEmail: string): Promise<HermesProjectAssignments> {
  const { data, error } = await supabaseAdmin
    .from("hermes_sessions")
    .select("id, project_id, updated_at")
    .eq("user_email", userEmail)
    .not("project_id", "is", null)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const bySession: Record<string, string> = {};
  const lastActivity: Record<string, string> = {};
  for (const row of (data ?? []) as { id: string; project_id: string; updated_at: string }[]) {
    bySession[row.id] = row.project_id;
    // Rows arrive newest first, so the first sighting of a project IS its latest activity.
    if (!lastActivity[row.project_id]) lastActivity[row.project_id] = row.updated_at;
  }
  return { bySession, lastActivity };
}

/**
 * One call answering "how are we doing" — the live snapshot the Hermes directive injects each turn
 * and the `overview` tool returns. Every number is a head-count query (no rows fetched), fanned out
 * in parallel, and every failure degrades to null rather than 0 so a missing table and a genuine
 * zero can never look identical (the adoption report's rule, applied here).
 */
export interface OperationsOverview {
  emails: {
    ready: number | null; scheduled: number | null; sent: number | null;
    replied: number | null; needs_human: number | null; negotiating: number | null;
    agreed: number | null; bounced: number | null;
    /** Replies nobody has answered yet (outreach_unanswered_replies view), and how many are past
     *  the SLA. null = the view was unreadable, never zero. */
    unanswered_replies: number | null; over_sla: number | null; oldest_unanswered_hours: number | null;
  };
  drafts: { local_only: number | null; synced: number | null; published: number | null; sync_failed: number | null };
  backlinks: { campaigns: number | null; links_live: number | null };
  prospects: { authors: number | null; with_email: number | null };
  pipeline: { status: string; campaign: string | null } | null;
  payments: { owed: number | null; requested: number | null };
}

export async function operationsOverview(): Promise<OperationsOverview> {
  const count = async (table: string, apply?: (q: any) => any): Promise<number | null> => {
    try {
      let q = supabaseAdmin.from(table).select("id", { count: "exact", head: true });
      if (apply) q = apply(q);
      const { count: n, error } = await q;
      if (error) return null;
      return n ?? null;
    } catch {
      return null;
    }
  };

  const [
    ready, scheduled, sent, replied, needsHuman, negotiating, agreed, bounced,
    localOnly, synced, published, syncFailed,
    blCampaigns, linksLive,
    authors, withEmail,
    owed, requested,
    latestRun,
    backlog,
  ] = await Promise.all([
    count("outreach_emails", (q) => q.eq("status", "ready")),
    count("outreach_emails", (q) => q.eq("status", "scheduled")),
    count("outreach_emails", (q) => q.eq("status", "sent")),
    count("outreach_emails", (q) => q.not("replied_at", "is", null)),
    count("outreach_emails", (q) => q.eq("negotiation_status", "needs_human")),
    count("outreach_emails", (q) => q.eq("negotiation_status", "negotiating")),
    count("outreach_emails", (q) => q.eq("negotiation_status", "agreed")),
    count("outreach_emails", (q) => q.not("bounced_at", "is", null)),
    count("blog_drafts", (q) => q.eq("sync_state", "local_only")),
    count("blog_drafts", (q) => q.eq("sync_state", "synced")),
    count("blog_drafts", (q) => q.eq("sync_state", "published")),
    count("blog_drafts", (q) => q.eq("sync_state", "sync_failed")),
    count("backlink_campaigns"),
    count("backlink_prospects", (q) => q.not("link_live_at", "is", null)),
    count("authors", (q) => q.eq("discarded", false)),
    count("contacts", (q) => q.eq("type", "mailto")),
    count("outreach_emails", (q) => q.eq("payment_status", "owed")),
    count("outreach_emails", (q) => q.eq("payment_status", "requested")),
    supabaseAdmin.from("pipeline_runs").select("status, stats")
      .order("started_at", { ascending: false }).limit(1).maybeSingle()
      .then((r) => (r.error ? null : r.data), () => null),
    import("@/lib/negotiation/sla").then(async ({ unansweredBacklog }) => {
      const { getNegotiationSettings } = await import("@/lib/negotiation/settings");
      const slaHours = await getNegotiationSettings().then((s) => s.reply_sla_hours).catch(() => 24);
      return unansweredBacklog(slaHours);
    }).catch(() => ({ unanswered: null, overSla: null, oldestHours: null })),
  ]);

  return {
    emails: {
      ready, scheduled, sent, replied, needs_human: needsHuman, negotiating, agreed, bounced,
      unanswered_replies: backlog.unanswered, over_sla: backlog.overSla, oldest_unanswered_hours: backlog.oldestHours,
    },
    drafts: { local_only: localOnly, synced, published, sync_failed: syncFailed },
    backlinks: { campaigns: blCampaigns, links_live: linksLive },
    prospects: { authors, with_email: withEmail },
    pipeline: latestRun
      ? { status: (latestRun as { status?: string }).status ?? "unknown", campaign: null }
      : null,
    payments: { owed, requested },
  };
}

// ─── Sourcing effectiveness ────────────────────────────────────────────────────
// Reply/win rates by how the author was FOUND (authors.source: backlink, competitor-backlink,
// manual-backlink-list, competitor-blog, …). This is the feedback loop the sourcing work never
// had: every supply writes prospects, nothing measured which supply's prospects answer. Cohorted
// by when the author was sourced, so "last 90 days" means authors found then — not mail sent then.
export interface SourceEffectiveness {
  source: string;
  authors: number;
  with_email: number;
  sent: number;
  replied: number;
  won: number;
}

export async function sourcingEffectiveness(days = 90): Promise<SourceEffectiveness[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const authors = await fetchAllRows<{ id: string; source: string | null }>(
    "authors", "id, source", (q) => q.gte("created_at", cutoff),
  );
  if (!authors.length) return [];
  const byId = new Map(authors.map((a) => [a.id, a.source ?? "unknown"]));

  const [mailto, emails, wins] = await Promise.all([
    fetchAllRows<{ author_id: string }>("contacts", "author_id", (q) => q.eq("type", "mailto")),
    fetchAllRows<{ author_id: string; sent_at: string | null; replied_at: string | null }>(
      "outreach_emails", "author_id, sent_at, replied_at", (q) => q.eq("kind", "initial"),
    ),
    fetchAllRows<{ author_id: string }>("backlink_prospects", "author_id", (q) => q.eq("stage", "won")),
  ]);

  const agg = new Map<string, SourceEffectiveness>();
  const bucket = (source: string) => {
    const b = agg.get(source) ?? { source, authors: 0, with_email: 0, sent: 0, replied: 0, won: 0 };
    agg.set(source, b);
    return b;
  };
  for (const a of authors) bucket(byId.get(a.id)!).authors++;
  const seenEmail = new Set<string>(), seenSent = new Set<string>(), seenReplied = new Set<string>(), seenWon = new Set<string>();
  for (const c of mailto) {
    const s = byId.get(c.author_id);
    if (s && !seenEmail.has(c.author_id)) { seenEmail.add(c.author_id); bucket(s).with_email++; }
  }
  for (const e of emails) {
    const s = byId.get(e.author_id);
    if (!s) continue;
    if (e.sent_at && !seenSent.has(e.author_id)) { seenSent.add(e.author_id); bucket(s).sent++; }
    if (e.replied_at && !seenReplied.has(e.author_id)) { seenReplied.add(e.author_id); bucket(s).replied++; }
  }
  for (const w of wins) {
    const s = byId.get(w.author_id);
    if (s && !seenWon.has(w.author_id)) { seenWon.add(w.author_id); bucket(s).won++; }
  }
  return [...agg.values()].sort((a, b) => b.authors - a.authors);
}

// ── Summer's standing rules ────────────────────────────────────────────────────────────────────
//
// Things a person told her once that must hold in every conversation afterwards. See
// scripts/071_hermes_standing_rules.mjs for why this is a table rather than a line in the prompt.

export interface HermesStandingRule {
  id: string;
  rule: string;
  scope: string;
  active: boolean;
  created_by: string | null;
  created_at: string;
  session_id: string | null;
}

/** Active rules, oldest first so the order a person set them in is the order she reads them. */
export async function listStandingRules(includeRetired = false): Promise<HermesStandingRule[]> {
  let q = supabaseAdmin
    .from("hermes_standing_rules")
    .select("id, rule, scope, active, created_by, created_at, session_id")
    .order("created_at", { ascending: true });
  if (!includeRetired) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function addStandingRule(input: {
  rule: string; scope?: string; createdBy?: string | null; sessionId?: string | null;
}): Promise<HermesStandingRule> {
  const { data, error } = await supabaseAdmin
    .from("hermes_standing_rules")
    .insert({
      rule: input.rule.trim(),
      scope: input.scope ?? "global",
      created_by: input.createdBy ?? null,
      session_id: input.sessionId ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Retire rather than delete — "why did she stop doing that" stays answerable, and a rule dropped by
 *  mistake can be switched back on instead of reconstructed from somebody's memory. */
export async function retireStandingRule(id: string, by?: string | null): Promise<boolean> {
  const { error, count } = await supabaseAdmin
    .from("hermes_standing_rules")
    .update({ active: false, retired_at: new Date().toISOString(), retired_by: by ?? null }, { count: "exact" })
    .eq("id", id)
    .eq("active", true);
  if (error) throw error;
  return (count ?? 0) > 0;
}

// ── Agent feedback (§10.3) ──────────────────────────────────────────────────────
//
// One row per RUN. See scripts/083_agent_feedback.mjs for why the grain is the run and not the
// message, and why the trajectory is stored rather than just the score.

export interface AgentFeedback {
  run_id: string;
  session_id: string | null;
  surface: string;
  user_email: string;
  value: number;
  comment: string | null;
  trajectory: Array<{ tool: string; ok?: boolean; detail?: string }>;
  model: string | null;
  prompt_revision: number | null;
  created_at: string;
  updated_at: string;
}

/** Rate a run, or change an existing rating. Idempotent on run_id. */
export async function upsertAgentFeedback(row: {
  run_id: string;
  session_id?: string | null;
  surface?: string;
  user_email: string;
  value: number;
  comment?: string | null;
  trajectory?: unknown[];
  model?: string | null;
  prompt_revision?: number | null;
}): Promise<AgentFeedback> {
  const payload = {
    ...row,
    surface: row.surface ?? "summer",
    comment: row.comment ?? null,
    trajectory: row.trajectory ?? [],
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabaseAdmin
    .from("agent_feedback").upsert(payload, { onConflict: "run_id" }).select().single();
  if (error) throw error;
  return data as AgentFeedback;
}

/** Clicking the set thumb again removes the rating — a mis-click is one click to undo. */
export async function deleteAgentFeedback(runId: string): Promise<void> {
  const { error } = await supabaseAdmin.from("agent_feedback").delete().eq("run_id", runId);
  if (error) throw error;
}

export async function getAgentFeedback(runId: string): Promise<AgentFeedback | null> {
  const { data } = await supabaseAdmin.from("agent_feedback").select("*").eq("run_id", runId).maybeSingle();
  return (data as AgentFeedback) ?? null;
}

/** Every rating on a session, so a reopened thread shows the thumbs already set. */
export async function listAgentFeedbackForSession(sessionId: string): Promise<AgentFeedback[]> {
  const { data } = await supabaseAdmin
    .from("agent_feedback").select("*").eq("session_id", sessionId).order("created_at", { ascending: true });
  return (data ?? []) as AgentFeedback[];
}

/**
 * What the ratings say, for feeding back into the agent's own prompt.
 *
 * Only NEGATIVE ratings carrying a comment are worth returning. A thumbs-down with no comment says
 * something went wrong and nothing about what, and a thumbs-up teaches nothing actionable — "keep
 * doing that" is already the default. So this is the corrections list, newest first.
 *
 * Capped hard. This text goes into a cached system prompt, and an unbounded list would both blow the
 * cache on every new rating and drown the rules that matter in a hundred one-off gripes.
 */
export async function recentAgentCorrections(limit = 12): Promise<Array<{ comment: string; when: string }>> {
  const { data } = await supabaseAdmin
    .from("agent_feedback")
    .select("comment, created_at")
    .eq("value", 0)
    .not("comment", "is", null)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 30)));
  return (data ?? [])
    .map((r: { comment: string | null; created_at: string }) => ({
      comment: String(r.comment ?? "").trim(),
      when: String(r.created_at ?? "").slice(0, 10),
    }))
    .filter((r) => r.comment.length > 0);
}

/** Ratings by prompt revision — the read that turns "it feels worse" into a number. */
export async function feedbackByRevision(): Promise<Array<{ prompt_revision: number | null; up: number; down: number }>> {
  const { data } = await supabaseAdmin.from("agent_feedback").select("prompt_revision, value").limit(5000);
  const by = new Map<number | null, { up: number; down: number }>();
  for (const r of (data ?? []) as Array<{ prompt_revision: number | null; value: number }>) {
    const k = r.prompt_revision ?? null;
    const cur = by.get(k) ?? { up: 0, down: 0 };
    if (r.value === 1) cur.up++; else cur.down++;
    by.set(k, cur);
  }
  return [...by.entries()]
    .map(([prompt_revision, v]) => ({ prompt_revision, ...v }))
    .sort((a, b) => (b.prompt_revision ?? -1) - (a.prompt_revision ?? -1));
}
