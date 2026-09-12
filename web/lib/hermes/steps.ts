// Plain-English step descriptions for Hermes tool calls. A leaf module on purpose, exactly like
// src/lib/writer/steps.ts: the live stream (agent.ts) and the rehydrated transcript
// (api/hermes/sessions/[id]/route.ts) both need this, and nothing here may touch the SDK, the
// network or the database. The selfcheck asserts every tool in HERMES_TOOLS has a label here, so
// adding a tool without one is a caught mistake rather than a raw name in the UI.

export function describeHermesTool(
  name: string,
  input: Record<string, unknown>,
): { label: string; detail?: string } {
  const q = (v: unknown) => (v ? `“${String(v)}”` : undefined);
  const s = (v: unknown) => (v == null ? undefined : String(v));
  switch (name) {
    // ── read ──
    case "overview":
      return { label: "Reading the operations snapshot" };
    case "search_prospects":
      return { label: "Searching prospects", detail: q(input.query) ?? "all" };
    case "prospect_detail":
      return { label: "Reading a prospect", detail: s(input.author_id) };
    case "list_backlink_campaigns":
      return { label: "Listing backlink campaigns" };
    case "backlink_funnel":
      return { label: "Reading a backlink funnel", detail: s(input.campaign_id) };
    case "list_threads":
      return { label: "Reading negotiation threads" };
    case "read_thread":
      return { label: "Reading a conversation", detail: s(input.anchor_id) };
    case "email_queue_status":
      return { label: "Checking the email queue" };
    case "list_drafts":
      return { label: "Listing drafts", detail: s(input.status) };
    case "read_draft":
      return { label: "Reading a draft", detail: s(input.draft_id) };
    case "site_health_summary":
      return { label: "Reading site health" };
    case "keyword_data":
      return { label: "Pulling Search Console data", detail: q(input.keyword) };
    case "adoption_report":
      return { label: "Building the adoption report" };
    case "browse_page":
      return { label: "Reading a page with a real browser", detail: s(input.url) };
    case "deep_research":
      return { label: "Researching on the web", detail: q(input.question) };
    // ── act (reversible) ──
    case "create_backlink_campaign":
      return { label: "Creating a backlink campaign", detail: s(input.name) ?? s(input.target) };
    case "discover_prospects":
      return { label: "Discovering prospects", detail: s(input.campaign_id) };
    case "run_enrichment":
      return { label: "Starting email finding", detail: s(input.campaign_id) };
    case "draft_pitches":
      return { label: "Drafting pitches", detail: s(input.campaign_id) };
    case "verify_backlinks":
      return { label: "Re-checking for live links", detail: s(input.campaign_id) };
    case "start_discovery":
      return { label: "Starting a discovery run", detail: s(input.campaign_id) };
    case "create_blog_draft":
      return { label: "Creating a draft", detail: q(input.title) };
    case "generate_assets": {
      const n = Number(input.count ?? 1);
      return { label: `Generating ${Number.isFinite(n) && n > 1 ? `${n} images` : "an image"}`, detail: q(input.subject) };
    }
    case "serp_analysis":
      return { label: "Analysing the search results page", detail: q(input.keyword) };
    case "standing_rule":
      return { label: input.action === "list" ? "Reading the standing rules" : input.action === "retire" ? "Retiring a standing rule" : "Recording a standing rule" };
    case "imagine_videos":
      return { label: "Looking for one of our videos", detail: s(input.subject) };
    case "practitioner_brief":
      return { label: input.persona ? "Reading the practitioner brief" : "Listing practitioner personas", detail: s(input.persona) };
    case "imagine_updates":
      return { label: "Reading what ImagineArt shipped" };
    case "prompt_examples":
      return { label: input.studio ? "Reading how people prompt" : "Reading prompt patterns", detail: s(input.studio) };
    case "house_style":
      return { label: "Reading the house voice", detail: s(input.voice_slug) ?? s(input.surface) };
    case "internal_links":
      return { label: "Finding internal links", detail: q(input.query) };
    case "update_draft":
      return { label: "Updating a draft", detail: s(input.draft_id) };
    case "run_url_sweep": {
      const pats = Array.isArray(input.patterns) ? input.patterns.map(String).join(", ") : undefined;
      return { label: "Sweeping links to retired URLs", detail: pats ?? "the known retired set" };
    }
    case "url_sweep_report":
      return { label: "Reading a URL-sweep report" };
    case "whats_coming":
      return { label: input.refresh ? "Sweeping the launch sources live" : "Reading this morning's launch sweep" };
    case "run_page_health_scan":
      return { label: "Scanning page health" };
    case "takeover_thread":
      return { label: "Taking a thread off AI management", detail: s(input.author_id) };
    case "assist_negotiation":
      return { label: "Drafting a negotiation reply", detail: s(input.anchor_id) };
    case "toggle_followup":
      return { label: input.armed ? "Arming a follow-up" : "Disarming a follow-up", detail: s(input.followup_id) };
    // ── propose (gated) ──
    case "propose_action":
      return { label: "Proposing an action for your approval", detail: s(input.summary) ?? s(input.kind) };
    // ── UI ──
    case "show_table":
      return { label: "Laying out a table", detail: s(input.title) };
    case "show_options":
      return { label: "Offering options", detail: s(input.question) };
    // ── competitor backlink flow ──
    case "competitor_backlinks":
      return { label: "Fetching a competitor's backlinks from Ahrefs", detail: s(input.competitor) };
    case "add_prospects_from_urls": {
      const n = Array.isArray(input.urls) ? input.urls.length : 0;
      return { label: "Harvesting contacts from chosen pages", detail: n ? `${n} URL${n === 1 ? "" : "s"}` : undefined };
    }
    case "show_picker":
      return { label: "Laying out a selection list", detail: s(input.title) };
    // ── sourcing v2 ──
    case "competitor_link_intersect": {
      const comps = Array.isArray(input.competitors) ? input.competitors.map(String).join(" ∩ ") : undefined;
      return { label: "Intersecting competitor link profiles", detail: comps };
    }
    case "competitor_authors": {
      const comps = Array.isArray(input.competitors) ? input.competitors.map(String).join(", ") : undefined;
      return { label: "Mining competitor blogs for writers", detail: comps };
    }
    case "sourcing_report":
      return { label: "Measuring which prospect sources convert" };
    // ── the machine ──
    case "automation_status":
      return { label: "Reading the machine's logbook" };
    // ── zero-unit prospecting ──
    case "find_link_pages":
      return { label: "Searching for pages that link out", detail: q(input.topic) };
    case "find_unlinked_mentions":
      return { label: "Hunting unlinked brand mentions" };
    case "domain_emails": {
      const ds = Array.isArray(input.domains) ? input.domains.map(String).join(", ") : undefined;
      return { label: "Reading the domain's address book", detail: ds };
    }
    case "add_prospects_with_emails": {
      const n = Array.isArray(input.entries) ? input.entries.length : 0;
      return { label: "Filing picked addresses as prospects", detail: n ? `${n} address${n === 1 ? "" : "es"}` : undefined };
    }
    // ── pitch editing ──
    case "edit_pitches": {
      const n = Array.isArray(input.edits) ? input.edits.length : 0;
      return { label: "Rewriting saved pitches", detail: n ? `${n} pitch${n === 1 ? "" : "es"}` : undefined };
    }
    // ── mailbox verification ──
    case "verify_emails": {
      const n = Array.isArray(input.emails) ? input.emails.length : 0;
      return { label: "Verifying mailboxes with Reoon", detail: n ? `${n} address${n === 1 ? "" : "es"}` : undefined };
    }
    default:
      return { label: name };
  }
}
