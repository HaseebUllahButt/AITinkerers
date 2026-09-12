export interface Domain {
  id: string;
  host: string;
  name?: string;
  cms_guess?: string;
  dr_proxy_score: number;
  dr?: number | null;                 // real Ahrefs Domain Rating (free endpoint)
  dr_checked_at?: string | null;
  organic_traffic?: number | null;    // monthly organic visits; null = unverified (needs paid plan)
  us_traffic_share?: number | null;   // 0-100 %; null = unverified
  traffic_checked_at?: string | null;
  metrics_source?: string | null;
  country?: string;
  language?: string;
  first_seen: string;
  last_seen: string;
  created_at: string;
}

// Per-prospect qualification (from src/lib/score/qualify.ts), attached to ProspectCard.
export interface ProspectQualification {
  dr: number | null;
  drPass: boolean;
  traffic: number | null;
  trafficPass: boolean | null;
  usShare: number | null;
  usPass: boolean | null;
  relevance: number;
  relevancePass: boolean;
  qualified: boolean;
  fit: number;
  checks: { label: string; state: "pass" | "fail" | "unverified" }[];
}

export interface Author {
  id: string;
  full_name: string;
  slug?: string;
  avatar_url?: string;
  bio?: string;
  role?: string;
  primary_domain_id?: string;
  same_as_json: string[];
  description?: string;
  source?: string;
  discarded?: boolean;
  safety_score?: number | null;
  safety_summary?: string | null;
  safety_checked_at?: string | null;
  created_at: string;
  updated_at: string;
  // joined
  domain?: Domain;
  contacts?: Contact[];
  articles?: Article[];
  score?: Score;
}

// One flagged post for an author's safety screening (NSFW / hate-violence-illegal /
// political-controversy). See src/lib/extract/safety.ts.
export interface FlaggedContent {
  id: string;
  author_id: string;
  article_id: string;
  category: "nsfw" | "hate_violence_illegal" | "political_controversy";
  severity: "low" | "medium" | "high";
  reason?: string;
  created_at: string;
  article?: { title?: string; url_canonical?: string };
}

export interface Article {
  id: string;
  url_canonical: string;
  title?: string;
  excerpt?: string;
  published_at?: string;
  lastmod?: string;
  lead_image_url?: string;
  domain_id?: string;
  archetype?: string;
  readability_text_excerpt?: string;
  source?: string;
  created_at: string;
  // joined
  domain?: Domain;
  authors?: Author[];
  mentions?: Mention[];
}

export interface Contact {
  id: string;
  author_id?: string;
  domain_id?: string;
  type: "mailto" | "form" | "author_page" | "twitter" | "linkedin" | "mastodon" | "youtube" | "instagram" | "whatsapp";
  value: string;
  confidence: number;
  source?: string;
  verified_syntax: boolean;
  created_at: string;
  /** Who this address actually belongs to, when that is NOT the author it hangs off — a Hunter
   *  domain-search alt contact (an editor or founder found at the same publication). Drives the pitch
   *  greeting: null means "greet the author", which is the normal case. Getting this wrong sends a pitch
   *  opening "Hi Sarah," to a different person, which permanently burns the prospect. */
  owner_name?: string | null;
  owner_position?: string | null;
}

export interface Mention {
  id: string;
  article_id: string;
  tool_name: string;
  count: number;
}

export interface Score {
  id: string;
  author_id?: string;
  article_id?: string;
  relevance: number;
  freshness: number;
  authority: number;
  competitor_overlap: number;
  contact_confidence: number;
  composite: number;
  computed_at: string;
}

export interface DiscoveryHit {
  id: string;
  url: string;
  source: string;
  query?: string;
  title?: string;
  snippet?: string;
  discovered_at: string;
  processed: boolean;
}

export interface SeedTool {
  id: string;
  name: string;
  aliases: string[];
  enabled: boolean;
  category: "our_product" | "competitor" | "topic";
  created_at: string;
}

export interface HarvesterConfig {
  id: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface PipelineRun {
  id: string;
  started_at: string;
  finished_at?: string;
  stage?: string;
  status: "running" | "completed" | "failed";
  stats: Record<string, unknown>;
  error?: string;
}

export interface Suppression {
  id: string;
  type: "domain" | "author" | "url";
  value: string;
  reason?: string;
  added_at: string;
}

export interface RawHit {
  url: string;
  title?: string;
  snippet?: string;
  source: string;
  query?: string;
  discoveredAt: string;
}

export interface ProspectCard {
  author: Author;
  articles: Article[];
  contacts: Contact[];
  mentions: string[];
  score: Score | null;
  domain: Domain | null;
  flaggedContent?: FlaggedContent[];
  qualification?: ProspectQualification;
}

export interface DashboardStats {
  totalProspects: number;
  totalAuthors: number;
  totalPublications: number;
  contactablePercent: number;
  newThisWeek: number;
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export interface Campaign {
  id: string;
  name: string;
  keywords: string[];
  region?: string;
  target_hits: number;
  status: "draft" | "running" | "done";
  created_at: string;
  author_count?: number;
  seed_writer_name?: string | null;
  seed_article_url?: string | null;
  seed_domains?: string[] | null;      // sites to mine for authors
  seed_article_urls?: string[] | null; // specific article URLs to pull authors from
}

// ─── Workflows ────────────────────────────────────────────────────────────────

export type EmailStatusFilter = "any" | "has" | "verified" | "guessed" | "none" | "linkedin_no_email";

export interface WorkflowFilters {
  minScore?: number;
  archetype?: string;
  tool?: string;
  hasContact?: boolean;
  emailStatus?: EmailStatusFilter;
  notContacted?: boolean; // only authors not yet emailed/queued (respects manual override)
  region?: string;
  minArticles?: number;
  limit?: number;
  sortDir?: "asc" | "desc";
}

export interface Workflow {
  id: string;
  campaign_id?: string;
  name: string;
  filters: WorkflowFilters;
  status: "draft" | "running" | "ready";
  prospect_count?: number;
  created_at: string;
  campaign?: Pick<Campaign, "id" | "name">;
}

export interface WorkflowProspect {
  id: string;
  workflow_id: string;
  author_id: string;
  included: boolean;
  rank?: number;
  created_at: string;
  author?: Author;
  score?: Score | null;
  contacts?: Contact[];
  articles?: Article[];
  domain?: Domain | null;
}

// ─── Email Templates ──────────────────────────────────────────────────────────

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  guidance?: string; // optional writing direction for the AI {{custom_line}} opener
  channel?: "email" | "linkedin"; // which outreach channel this template is for (default email)
  created_at: string;
  updated_at: string;
}

// A generated LinkedIn connection note for one prospect (copy-paste, not sent).
export interface LinkedinMessage {
  id: string;
  workflow_id: string;
  author_id: string;
  template_id?: string | null;
  body: string;
  /** When a person marked the DM as actually sent (080). Sending itself is manual copy-paste. */
  sent_at?: string | null;
  sent_by?: string | null;
  created_at: string;
  updated_at: string;
}

// A generated WhatsApp first message for one prospect (copy-paste / wa.me, not sent by us).
export interface WhatsappMessage {
  id: string;
  workflow_id: string;
  author_id: string;
  template_id?: string | null;
  body: string;
  /** When a person marked the DM as actually sent (082). Sending itself is manual, from their phone. */
  sent_at?: string | null;
  sent_by?: string | null;
  created_at: string;
  updated_at: string;
}

// One message in a WhatsApp VENDOR thread (085) — a running two-way negotiation with a known
// vendor, unlike the single drafted first-DM above. Phase 1 rows are human-logged (composer
// send, paste-in of a chat export); Cloud API webhook rows arrive in Phase 2 with wa_message_id.
export interface WhatsappThreadMessage {
  id: string;
  author_id: string;
  /** Vendor threads usually predate any campaign; linked when a deal attaches to one. */
  workflow_id?: string | null;
  direction: "inbound" | "outbound";
  body: string;
  media_url?: string | null;
  media_type?: string | null;
  /** WhatsApp's own message id — webhook/bridge dedupe (Phase 2). Null on human-logged rows. */
  wa_message_id?: string | null;
  source: "composer" | "manual_paste" | "webhook" | "bridge" | "negotiator";
  status: "draft" | "sent" | "delivered" | "read" | "failed";
  /** Why an API send failed (086) — a failed row must say so, never sit mute. */
  error?: string | null;
  /** When the message actually happened — the human's send moment, or the paste-parsed time. */
  sent_at?: string | null;
  /** Outbound only: who pressed send in WhatsApp (the wa.me trust model, as in 082). */
  sent_by?: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Outreach Emails ──────────────────────────────────────────────────────────

export interface OutreachEmail {
  id: string;
  workflow_id: string;
  author_id: string;
  template_id?: string;
  subject?: string;
  body?: string;
  status: "draft" | "ready" | "scheduled" | "sent" | "failed";
  scheduled_at?: string;
  sent_at?: string;
  error?: string;
  sender_email?: string | null;
  replied_at?: string | null;
  /** What this message IS in its thread, which decides whether it is paced when sent:
   *  'initial' (or null on the oldest rows) and 'followup' are cold and paced; 'negotiation'
   *  answers a live conversation and is exempt. See the pacing gate in /api/emails/process. */
  kind?: "initial" | "followup" | "negotiation" | null;
  parent_id?: string | null;
  created_at: string;
  author?: Author;
}

// Per-user sending identity + schedule. Each logged-in user sends from their own Gmail.
export interface UserEmailConfig {
  user_email: string;
  from_name?: string;
  timezone: string;
  send_hour_start: number;
  send_hour_end: number;
  gap_minutes: number;
  daily_cap: number;
  hasPassword: boolean; // never expose the password itself to the client
}

export interface EmailSendConfig {
  id: string;
  workflow_id: string;
  timezone: string;
  send_hour_start: number;
  send_hour_end: number;
  gap_minutes: number;
  daily_cap: number;
  from_name?: string;
  from_email?: string;
  provider: "smtp" | "blitz";
  created_at: string;
}
