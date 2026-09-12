// Cross-campaign duplicate detection, domain-keyed. The author-level guards (getContactedAuthorIds,
// the 30-day skip in draftBacklinkPitches) only catch the SAME person twice — two campaigns holding
// two different writers at the same publication sail past both, and the second pitch lands at a
// site that already heard from us. This answers, per host: is this domain sitting in another
// campaign's list, and — stronger — has anyone here actually emailed it, from anywhere?
//
// Advisory by design: callers flag, never block. The team's ask was "identify and flag it", and the
// send pipeline's own guards (getContactedAuthorIds at generate/send time, addressHasOtherSentInitial
// at the moment of sending) stay the enforcement layer.
import { supabaseAdmin } from "@/lib/db/supabase";
import { fetchAllRows } from "@/lib/db/queries";
import { registrableDomain } from "@/lib/util/domain";

export interface PriorContact {
  /** Display names of OTHER campaigns whose prospect list holds this domain. */
  otherCampaigns: string[];
  /** Most recent send to this domain from anywhere, if one exists. */
  contactedAt: string | null;
  /** Who that send went out as (sender_email / sent_by_email). */
  contactedBy: string | null;
  /** The campaign or workflow the send belonged to, for the badge tooltip. */
  via: string | null;
}

// The canonical "was contacted" predicate — same shape as getContactedAuthorIds: queued counts,
// because a scheduled send will go out whether or not the flag is shown.
const CONTACTED_OR = "status.in.(sent,scheduled),sent_at.not.is.null,replied_at.not.is.null,bounced_at.not.is.null";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Map of registrableDomain(host) → PriorContact for every requested host with prior history.
 * Hosts with no history are simply absent. Throws on any read error — a Map that silently lost
 * a query would render "no duplicates" over real ones (the load-honesty rule).
 *
 * Matching is org-level via registrableDomain, so blog.example.com in one campaign collides with
 * example.com in another. That requires comparing in JS, so other-campaign prospect rows are
 * fetched wholesale — a slim four-column projection over a table in the low thousands. If the
 * table ever grows past that, narrow Q1 to `.in("domain", hosts)` and accept host-exact matching.
 */
export async function priorContactForHosts(
  hosts: string[],
  opts: { excludeCampaignId: string; excludeWorkflowId: string },
): Promise<Map<string, PriorContact>> {
  const out = new Map<string, PriorContact>();
  const wanted = new Set(hosts.filter(Boolean).map((h) => registrableDomain(h)));
  if (!wanted.size) return out;

  const entry = (key: string): PriorContact => {
    let e = out.get(key);
    if (!e) { e = { otherCampaigns: [], contactedAt: null, contactedBy: null, via: null }; out.set(key, e); }
    return e;
  };
  // Keep the LATEST send: recency is what the tooltip's reader is judging spam risk by.
  const recordSend = (key: string, sentAt: string | null, by: string | null, via: string | null) => {
    const e = entry(key);
    const at = sentAt ?? "";
    if (!e.contactedAt || at > e.contactedAt) { e.contactedAt = sentAt; e.contactedBy = by; e.via = via; }
  };

  // Q1 — this domain in OTHER campaigns' lists (any stage: merely listed already means a
  // colleague is working the same site).
  const others = await fetchAllRows<{ domain: string; backlink_campaign_id: string; outreach_email_id: string | null }>(
    "backlink_prospects",
    "domain, backlink_campaign_id, outreach_email_id",
    (q) => q.neq("backlink_campaign_id", opts.excludeCampaignId),
  );
  const matched = others.filter((r) => r.domain && wanted.has(registrableDomain(r.domain)));

  const campaignIds = [...new Set(matched.map((r) => r.backlink_campaign_id))];
  const campaignName = new Map<string, string>();
  if (campaignIds.length) {
    const { data, error } = await supabaseAdmin
      .from("backlink_campaigns").select("id, name, target_path, created_by").in("id", campaignIds);
    if (error) throw error;
    for (const c of (data ?? []) as { id: string; name: string | null; target_path: string; created_by: string | null }[]) {
      // The owner in the label is the whole point of the badge for a colleague: it says WHO to
      // talk to before both lists pitch the same site.
      campaignName.set(c.id, `${c.name ?? c.target_path}${c.created_by ? ` — ${c.created_by.split("@")[0]}` : ""}`);
    }
  }
  for (const r of matched) {
    const e = entry(registrableDomain(r.domain));
    const label = campaignName.get(r.backlink_campaign_id) ?? "another campaign";
    if (!e.otherCampaigns.includes(label)) e.otherCampaigns.push(label);
  }

  // Q2 — of those listings, which were actually emailed (or are queued to be).
  const rowByPitchId = new Map<string, { domain: string; backlink_campaign_id: string }>();
  for (const r of matched) if (r.outreach_email_id) rowByPitchId.set(r.outreach_email_id, r);
  for (const ids of chunk([...rowByPitchId.keys()], 400)) {
    const { data, error } = await supabaseAdmin
      .from("outreach_emails")
      .select("id, sent_at, sender_email, sent_by_email")
      .in("id", ids)
      .or(CONTACTED_OR);
    if (error) throw error;
    for (const m of (data ?? []) as { id: string; sent_at: string | null; sender_email: string | null; sent_by_email: string | null }[]) {
      const row = rowByPitchId.get(m.id);
      if (!row) continue;
      recordSend(
        registrableDomain(row.domain),
        m.sent_at,
        m.sent_by_email ?? m.sender_email,
        campaignName.get(row.backlink_campaign_id) ?? null,
      );
    }
  }

  // Q3 — sends that never went through a backlink campaign (the /workflows path). Reached via
  // domains.host → authors.primary_domain_id → outreach_emails. Host-exact only: both columns are
  // stored www-stripped + lowercased, but an org-level match here would mean fetching every domain
  // row; Q1 already covers the subdomain case where it actually occurs (backlink prospect lists).
  const hostList = [...new Set(hosts.filter(Boolean))];
  for (const hs of chunk(hostList, 400)) {
    const { data: doms, error: domErr } = await supabaseAdmin.from("domains").select("id, host").in("host", hs);
    if (domErr) throw domErr;
    const domainIds = (doms ?? []).map((d: { id: string }) => d.id);
    if (!domainIds.length) continue;
    const hostByDomainId = new Map((doms ?? []).map((d: { id: string; host: string }) => [d.id, d.host]));

    const { data: auths, error: authErr } = await supabaseAdmin
      .from("authors").select("id, primary_domain_id").in("primary_domain_id", domainIds);
    if (authErr) throw authErr;
    const domainByAuthor = new Map((auths ?? []).map((a: { id: string; primary_domain_id: string }) => [a.id, a.primary_domain_id]));
    const authorIds = [...domainByAuthor.keys()];

    for (const aids of chunk(authorIds, 400)) {
      const { data: mails, error: mailErr } = await supabaseAdmin
        .from("outreach_emails")
        .select("author_id, workflow_id, sent_at, sender_email, sent_by_email")
        .in("author_id", aids)
        .neq("workflow_id", opts.excludeWorkflowId)
        .or(CONTACTED_OR);
      if (mailErr) throw mailErr;
      const rows = (mails ?? []) as { author_id: string; workflow_id: string | null; sent_at: string | null; sender_email: string | null; sent_by_email: string | null }[];

      const wfIds = [...new Set(rows.map((m) => m.workflow_id).filter(Boolean))] as string[];
      const wfName = new Map<string, string>();
      if (wfIds.length) {
        const { data: wfs, error: wfErr } = await supabaseAdmin.from("workflows").select("id, name").in("id", wfIds);
        if (wfErr) throw wfErr;
        for (const w of (wfs ?? []) as { id: string; name: string | null }[]) wfName.set(w.id, w.name ?? "");
      }
      for (const m of rows) {
        const host = hostByDomainId.get(domainByAuthor.get(m.author_id) ?? "");
        if (!host) continue;
        const key = registrableDomain(host);
        if (!wanted.has(key)) continue;
        recordSend(key, m.sent_at, m.sent_by_email ?? m.sender_email, wfName.get(m.workflow_id ?? "") || null);
      }
    }
  }

  return out;
}
