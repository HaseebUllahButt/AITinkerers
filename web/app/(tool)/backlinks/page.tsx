"use client";

/**
 * Backlink Outreach — the single workspace for link building.
 *
 * This page is deliberately the whole job in one place: pick the page you want links to, watch the bot
 * find and qualify prospects, see what it is doing, and deal with the few things only a person can
 * decide. Everything it shows is scoped to ONE campaign at a time, because "which target page is this
 * about" is the question every other number depends on.
 *
 * Design constraints this is built to, in priority order:
 *
 *   1. A non-technical teammate must be able to run it. Plain words over jargon ("Has a real email",
 *      not "sourced contact"), big targets, and no control whose effect isn't stated next to it.
 *   2. Nothing important lives on another page. The funnel used to hand off to /sending, /inbox,
 *      /negotiation and /payments; those are still reachable, but the counts and the things needing a
 *      human are surfaced here so the workspace is never a dead end.
 *   3. Ranking is explained, not hidden. Score, Domain Rating and email quality are three separate
 *      columns you can sort on, because a blended number nobody can argue with is a number nobody
 *      trusts. See EMAIL_TRUST_LABEL.
 *
 * See Outreach_inventory.md for the capability register this must not regress.
 */

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { toast } from "sonner";
import {
  Link2, Play, Loader2, Search, Mail, PenLine, Send, CheckCircle2, ExternalLink,
  ShieldCheck, Inbox, Plus, TriangleAlert, ArrowUpDown, CreditCard, Phone, HandCoins, Compass,
  Tags, Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PathCombobox } from "@/components/ui/path-combobox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AutopilotCard } from "@/components/AutopilotCard";
import { LoadFailed, fetchHonest } from "@/components/ui/load-failed";
import { PolicyCard } from "@/components/backlinks/PolicyCard";
import { SourcingReportCard } from "@/components/backlinks/SourcingReportCard";
import { useKnownPages } from "@/lib/hooks/useKnownPages";
import { PitchDialog, type PitchTarget } from "@/components/backlinks/PitchDialog";
import { PitchAngleDialog } from "@/components/backlinks/PitchAngleDialog";
import { PageHeader } from "@/components/layout/PageHeader";

type EmailTrust = "sourced" | "verified" | "guess" | "none";

interface Prospect {
  id: string; authorId: string; domain: string; prospectUrl: string; angle: string | null; score: number | null;
  stage: string; author: string | null; hasEmail: boolean; email: string | null; linkLiveAt: string | null;
  dr: number | null; emailSource: string | null; emailConfidence: number | null; emailTrust: EmailTrust;
  emailOwner: string | null; emailOwnerPosition: string | null;
  contactChannel: "email" | "whatsapp" | "form" | "linkedin" | "social" | "none";
  formUrl: string | null; linkedinUrl: string | null;
  /** DM-ready connection note (LinkedIn-only prospects), edited in the pitch dialog. */
  linkedinNote: string | null;
  linkedinNoteSentAt: string | null;
  linkedinNoteSentBy: string | null;
  /** The stored wa.me link + chat-sized message (WhatsApp channel), edited in the pitch dialog. */
  whatsappUrl: string | null;
  whatsappNote: string | null;
  whatsappNoteSentAt: string | null;
  whatsappNoteSentBy: string | null;
  /** Prior history with this domain outside this campaign. Null = clean. */
  dup: { otherCampaigns: string[]; contactedAt: string | null; contactedBy: string | null; via: string | null } | null;
  /** Which SERP surfaces named this page, strongest first, and the label for them. Null/empty on
   *  prospects added from a pasted list or saved before discovery started recording it. */
  discoverySurfaces: string[];
  discoveryLabel: string | null;
  discoveryQuery: string | null;
  pitch: {
    id: string; subject: string | null; body: string | null; status: string | null;
    sentAt: string | null; scheduledAt: string | null; editedAt: string | null;
    editedBy: string | null; editable: boolean;
  } | null;
}
interface Campaign { id: string; name: string | null; created_by: string | null; target_path: string; target_url: string; topic: string | null; workflow_id: string; campaign_id: string; pitch_mode?: "article" | "site" | null; pitch_angle?: string | null; keywords?: string[] | null; }
interface CampaignRow extends Campaign { stageCounts: Record<string, number>; total: number; }
interface Attention {
  interventions: Array<{ id: string; type: string; ask: string | null; who: string | null }>;
  awaitingPayment: number;
  aiPaused: number;
}
/** Cumulative results of this campaign's sends — rates, where the stage tiles are positions. */
interface Performance {
  sent: number; replied: number; bounced: number; agreed: number; won: number;
  replyRate: number | null;
  bySender: Array<{ sender: string; sent: number; replied: number }>;
}

const STAGE_UI: Record<string, { label: string; cls: string }> = {
  found: { label: "Found", cls: "text-muted-foreground bg-muted border-border" },
  emailing: { label: "Finding email", cls: "text-highlight-ink bg-highlight-soft border-highlight/30" },
  ready: { label: "Pitch ready", cls: "text-highlight-ink bg-highlight-soft border-highlight/40" },
  sent: { label: "Sent", cls: "text-warning bg-warning/10 border-warning/30" },
  replied: { label: "Replied", cls: "text-highlight-ink bg-highlight-soft border-highlight/40" },
  won: { label: "Link live", cls: "text-success bg-success/15 border-success/40" },
  lost: { label: "Lost", cls: "text-destructive bg-destructive/10 border-destructive/30" },
};

/** Email quality in words a person can act on. The tier comes from HOW the address was obtained —
 *  see emailTrust() in src/lib/backlinks/pipeline.ts. Guessed addresses are what bounce, so they are
 *  labelled as a risk rather than shown as an equal. */
const EMAIL_TRUST_LABEL: Record<EmailTrust, { label: string; hint: string; cls: string }> = {
  sourced: { label: "Real", hint: "Found on their site, a social profile, or via LinkedIn.", cls: "text-success bg-success/12 border-success/30" },
  verified: { label: "Verified", hint: "Built from the domain pattern, then confirmed the mailbox accepts mail.", cls: "text-success bg-success/12 border-success/30" },
  guess: { label: "Guessed", hint: "Built from a domain pattern and never confirmed. These are what bounce.", cls: "text-warning bg-warning/12 border-warning/30" },
  none: { label: "None yet", hint: "No address found. Run “Find emails”.", cls: "text-muted-foreground bg-muted border-border" },
};

/** Why a thread is parked, in the recipient's words rather than ours. Mirrors INTERVENTION_REASON in
 *  src/lib/negotiation/run.ts — kept short here because this is a queue, not a report. */
const INTERVENTION_LABEL: Record<string, { label: string; icon: typeof Phone }> = {
  sync_contact: { label: "Wants a call", icon: Phone },
  scheduling: { label: "Wants your availability", icon: Phone },
  other_channel: { label: "Wants to move to another channel", icon: Phone },
  payment_details: { label: "Wants invoice / bank details", icon: CreditCard },
  legal_contract: { label: "Wants a contract signed", icon: CreditCard },
  asset_request: { label: "Wants a document from us", icon: HandCoins },
  identity_verification: { label: "Wants proof of who we are", icon: ShieldCheck },
  redirect: { label: "Pointed us to someone else", icon: Mail },
  process_portal: { label: "Wants us to use their form", icon: Mail },
  factual_question: { label: "Asked something we must not guess", icon: TriangleAlert },
  over_policy: { label: "Wants more than our ceiling", icon: HandCoins },
  inbound_attachment: { label: "Sent us a file to read", icon: HandCoins },
  other: { label: "Needs a person", icon: TriangleAlert },
};

type SortKey = "score" | "dr" | "email";

/** "hussain.abbas@imagine.art" → "Hussain Abbas"; null → "shared" (a pre-ownership campaign). */
function ownerLabel(createdBy: string | null): string {
  if (!createdBy) return "shared";
  return createdBy.split("@")[0].split(/[._-]+/).filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

/** One keyword per line or comma, trimmed and deduped — the same normalising the server does, so
 *  the count shown next to a button is the count that will actually be searched. */
function parseKeywordList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const k = raw.replace(/\s+/g, " ").trim();
    if (!k || k.length > 80 || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
    if (out.length >= 12) break;
  }
  return out;
}

/** The full http(s) addresses in a pasted blob, deduped. Anything else is ignored rather than
 *  guessed at — a half-typed line should not become a page we go and fetch. */
function parseUrlList(text: string): string[] {
  const seen = new Set<string>();
  return text.split(/[\s,]+/)
    .map((t) => t.trim().replace(/^["'<(]+|["'>).,;]+$/g, ""))
    .filter((t) => /^https?:\/\//i.test(t))
    .filter((t) => { const k = t.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

export default function BacklinksPage() {
  const { data: session } = useSession();
  const myEmail = session?.user?.email ?? null;
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  /** Explicit choice; null = "not chosen yet", which derives to Mine when the person owns any
   *  campaign and Everyone otherwise — so a new teammate isn't greeted by an empty grid. */
  const [scopeChoice, setScopeChoice] = useState<"mine" | "all" | null>(null);
  const [funnel, setFunnel] = useState<{ campaign: Campaign; prospects: Prospect[]; attention: Attention; performance?: Performance } | null>(null);
  // Load failures, kept apart from the data they failed to fetch. Swallowing them rendered a dead
  // database as "no campaigns" / "No prospects yet" — nothing was gone, nothing said so. A failure
  // never clears what is already shown; it just puts a banner over it. Two states because the two
  // loads feed two different panels (the campaign cards vs. one campaign's funnel).
  const [campaignsError, setCampaignsError] = useState<string | null>(null);
  const [funnelError, setFunnelError] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [creating, setCreating] = useState(false);
  // Optional seeds for the campaign being created. Kept collapsed: most campaigns don't need them,
  // but when you already know which articles you're going after, nothing else should run.
  const [seedOpen, setSeedOpen] = useState(false);
  const [seedArticles, setSeedArticles] = useState("");
  const [seedKeywords, setSeedKeywords] = useState("");
  const [busy, setBusy] = useState<string>("");
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("score");
  // The prospect whose pitch is open. Holding the whole row rather than just an id keeps the dialog a
  // pure function of what the table already loaded, so opening it needs no second fetch.
  const [pitchFor, setPitchFor] = useState<Prospect | null>(null);
  // The campaign-level pitch-angle dialog (say the angle → sample → apply to every prospect).
  const [angleOpen, setAngleOpen] = useState(false);
  // The paste-a-backlink-list dialog.
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  // The extra-seed-keywords dialog. Text while editing; the campaign holds the saved list.
  const [kwOpen, setKwOpen] = useState(false);
  const [kwText, setKwText] = useState("");
  const knownPages = useKnownPages();

  /**
   * What did they actually paste — finished page URLs, or a competitor's domain?
   *
   * One box, two sources, because from the user's side it is one question ("here's what I have,
   * find me authors") and making them pick a mode first is a worse version of the same thing.
   * Full http(s) URLs mean they already did the Ahrefs research and curated a list. A bare domain
   * means they want us to pull the backlink profile ourselves.
   *
   * URLs win when both are present: a curated list is stronger evidence of intent than a stray
   * domain, and mining a profile as a side effect of pasting pages would spend Ahrefs units nobody
   * asked to spend.
   */
  const pasteIntent = useMemo(() => {
    const tokens = pasteText.split(/[\s,]+/).map((t) => t.trim().replace(/^["'<(]+|["'>).,;]+$/g, "")).filter(Boolean);
    const urls = [...new Set(tokens.filter((t) => /^https?:\/\//i.test(t)).map((t) => t.toLowerCase()))];
    if (urls.length) return { kind: "urls" as const, count: urls.length, domain: "" };
    // A bare hostname: at least one dot, no scheme, no path. Rejects prose so a half-typed
    // sentence doesn't look like a domain we're about to spend credits on.
    const domain = tokens.find((t) => /^(?!https?:)[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t)) ?? "";
    return { kind: domain ? ("domain" as const) : ("none" as const), count: 0, domain };
  }, [pasteText]);

  /**
   * Run whichever source the input implies.
   *
   * Separate from action() because both carry a body and report differently: the useful number is
   * how many of YOUR inputs produced an author, not how many prospects exist overall.
   */
  async function addFromPaste() {
    if (!selected || pasteIntent.kind === "none") return;
    const isUrls = pasteIntent.kind === "urls";
    setBusy("paste");
    try {
      const d = await fetch(`/api/backlinks/${selected}/action`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isUrls
          ? { action: "url-authors", text: pasteText }
          : { action: "backlink-authors", target: pasteIntent.domain }),
      }).then((r) => r.json());
      if (d?.ok) {
        const r = isUrls ? d.urlAuthors : d.backlinkAuthors;
        toast.success(
          isUrls
            ? `${r.authorsFound} author${r.authorsFound === 1 ? "" : "s"} found from ${r.urlsGiven} page${r.urlsGiven === 1 ? "" : "s"}.`
            : `${r.authorsFound} author${r.authorsFound === 1 ? "" : "s"} found from ${r.pagesRead} page${r.pagesRead === 1 ? "" : "s"} linking to ${r.target}.`,
        );
        // The per-item detail matters more than the headline: a page with no byline is a normal
        // outcome, and for the Ahrefs path the notes say how many rows were billed.
        for (const n of r.notes ?? []) toast.message(n);
        setPasteOpen(false); setPasteText("");
        await loadFunnel(selected); await loadCampaigns();
      } else toast.error(d?.error ?? "Failed.");
    } catch (e: any) { toast.error(e?.message ?? "Failed."); }
    finally { setBusy(""); }
  }

  const kwParsed = useMemo(() => parseKeywordList(kwText), [kwText]);

  // What the "Start campaign" button is actually about to do, worked out from what has been typed.
  const seedUrls = useMemo(() => parseUrlList(seedArticles), [seedArticles]);
  const seedKws = useMemo(() => parseKeywordList(seedKeywords), [seedKeywords]);

  /**
   * Save this campaign's extra seed keywords, and optionally search on them straight away.
   *
   * Two buttons rather than one because they cost differently: saving is free and changes what
   * every later run does, searching spends a query per keyword shape right now. Saving without
   * running is a legitimate thing to want (set it up, let the scheduled run use it), and a dialog
   * that only offered "save and spend" would hide that.
   */
  async function saveKeywords(runNow: boolean) {
    if (!selected) return;
    setBusy(runNow ? "keywords-run" : "keywords");
    try {
      const d = await fetch(`/api/backlinks/${selected}/action`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-keywords", keywords: kwParsed }),
      }).then((r) => r.json());
      if (!d?.ok) { toast.error(d?.error ?? "Could not save the keywords."); return; }
      toast.success(
        kwParsed.length
          ? `Saved ${kwParsed.length} keyword${kwParsed.length === 1 ? "" : "s"}. Every discovery run for this campaign will search on ${kwParsed.length === 1 ? "it" : "them"} from now on.`
          : "Cleared the extra keywords — discovery will search on the page's own topic only.",
      );
      setKwOpen(false);
      await loadFunnel(selected); await loadCampaigns();
      if (runNow) await action("discover");
    } catch (e: any) { toast.error(e?.message ?? "Could not save the keywords."); }
    finally { setBusy(""); }
  }

  const loadCampaigns = useCallback(async () => {
    const { data, reason } = await fetchHonest<{ campaigns: CampaignRow[] }>("/api/backlinks");
    if (data) { setCampaigns(data.campaigns); setCampaignsError(null); }
    else setCampaignsError(reason);
  }, []);
  const loadFunnel = useCallback(async (id: string) => {
    const { data, reason } = await fetchHonest<{ campaign: Campaign; prospects: Prospect[]; attention?: Attention }>(`/api/backlinks/${id}`);
    if (data) {
      setFunnel({ campaign: data.campaign, prospects: data.prospects, attention: data.attention ?? { interventions: [], awaitingPayment: 0, aiPaused: 0 } });
      setFunnelError(null);
    } else setFunnelError(reason);
  }, []);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);
  useEffect(() => { if (selected) loadFunnel(selected); }, [selected, loadFunnel]);
  // Land on the most recent campaign so the page is never an empty shell when work exists.
  useEffect(() => { if (!selected && campaigns.length) setSelected(campaigns[0].id); }, [selected, campaigns]);

  /**
   * Create the campaign, and run only what was asked for.
   *
   * Picking a page used to start a web-wide search on its own topic there and then. That is the
   * wrong default: when the round has a shape of its own — the "alternatives" articles, say — the
   * search spends credits on a set nobody wanted and the funnel fills with prospects to weed out.
   * So: articles pasted → read exactly those. "Search the web too" pressed → search. Otherwise the
   * campaign is just created, and the buttons on it start the work when you are ready.
   *
   * The page is optional too. A name and a list of articles is a complete campaign; with no page it
   * asks for a link to the site itself, which is what a brand-level round wanted all along.
   */
  async function createCampaign(discover: boolean) {
    if (!target.trim() && !campaignName.trim()) {
      toast.error("Give the campaign a name, or pick the page you want links to.");
      return;
    }
    setCreating(true);
    try {
      const d = await fetch("/api/backlinks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(target.trim() ? { target: target.trim() } : {}),
          ...(campaignName.trim() ? { name: campaignName.trim() } : {}),
          ...(seedUrls.length ? { articles: seedUrls } : {}),
          ...(seedKws.length ? { keywords: seedKws } : {}),
          discover,
          maxProspects: 15,
        }),
      }).then((r) => r.json());
      if (!d?.ok) { toast.error(d?.error ?? "Failed."); return; }

      const where = d.campaign.name ?? d.campaign.target_path;
      // Each branch reports the number that belongs to it. A campaign created without running
      // anything must not claim to have found people — that reads as a failed search.
      if (d.urlAuthors) {
        const r = d.urlAuthors;
        toast.success(`${r.authorsFound} author${r.authorsFound === 1 ? "" : "s"} found from ${r.urlsGiven} page${r.urlsGiven === 1 ? "" : "s"} for ${where}.`);
        for (const n of r.notes ?? []) toast.message(n);
      } else if (d.discovery) {
        toast.success(`Found ${d.discovery.saved} prospects for ${where}.`);
      } else {
        toast.success(
          `Campaign created for ${where}${seedKws.length ? ` with ${seedKws.length} keyword${seedKws.length === 1 ? "" : "s"} saved` : ""}. Nothing has been searched yet — use "Add from backlinks" or "Find prospects" below when you're ready.`,
        );
      }
      await loadCampaigns();
      setSelected(d.campaign.id);
      setTarget(""); setCampaignName("");
      setSeedArticles(""); setSeedKeywords(""); setSeedOpen(false);
    } catch (e: any) { toast.error(e?.message ?? "Failed."); }
    finally { setCreating(false); }
  }

  // Give this campaign's ready pitches a send time, as the person clicking. Deliberately the same
  // endpoint the old Emails screen used, rather than a new path: it already stamps the sender's own
  // Gmail, skips anyone contacted in another campaign, and refuses (needsAppPassword) instead of
  // quietly falling back to the server identity.
  async function scheduleSends() {
    if (!funnel?.campaign?.workflow_id) return;
    setBusy("send");
    try {
      const d = await fetch(`/api/workflows/${funnel.campaign.workflow_id}/send`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      }).then((r) => r.json());
      if (d?.needsAppPassword) {
        toast.error(d.error ?? "Add your Gmail app password in Settings so this sends from your own address.", {
          action: { label: "Settings", onClick: () => { window.location.href = "/settings"; } },
        });
      } else if (typeof d?.scheduled === "number" && d.scheduled > 0) {
        toast.success(
          `Scheduled ${d.scheduled} pitch${d.scheduled === 1 ? "" : "es"} to send from ${d.sender}` +
          `${d.skippedContacted ? ` — ${d.skippedContacted} skipped, already contacted in another campaign` : ""}.`,
        );
      } else if (d?.reason) toast.info(d.reason);
      else toast.error(d?.error ?? "Couldn't schedule the sends.");
      if (selected) { await loadFunnel(selected); await loadCampaigns(); }
    } catch (e: any) { toast.error(e?.message ?? "Couldn't schedule the sends."); }
    finally { setBusy(""); }
  }

  /**
   * One press writes EVERY pitch, however many passes that takes.
   *
   * The server drafts inside a 240s budget (the function dies at 300s; each pitch is one frontier-model
   * call) and reports what did not fit as `remaining`. The button used to surface that as "press again
   * to continue" — accurate, and on a campaign with 67 contactable prospects it meant pressing four or
   * five times and reading a toast each time. The resumability was always there (a drafted prospect is
   * never re-drafted); what was missing was the client using it. So this loops: call, refresh the funnel
   * so the "Pitch written" tile climbs, call again while anything remains, then print ONE report.
   *
   * Two guards keep it from spinning: a pass that draws nothing down (wrote nothing and `remaining`
   * did not shrink) stops the loop — a prospect that fails identically every pass would otherwise run
   * forever — and a hard cap on passes bounds the worst case at well under an hour.
   *
   * Counter semantics differ per key, so they are not all summed. `drafted*` are incremental (each
   * pass writes new ones). The `skipped*` counts and `remaining` are a snapshot of the whole list on
   * each pass — the deadline check sits BEFORE the skip classification, so only the last pass, the one
   * that reached the end of the list, classifies every prospect. `alreadyDrafted` is taken from the
   * first pass: on later passes it also counts the pitches this press just wrote.
   */
  async function draftAll(campaignId: string): Promise<Record<string, number> | null> {
    const MAX_PASSES = 12;
    const incremental = ["drafted", "draftedManual", "draftedSite", "draftedLinkedin", "draftedWhatsapp"];
    const total: Record<string, number> = {};
    let lastRemaining = Number.POSITIVE_INFINITY;
    const progress = toast.loading("Writing pitches…");
    try {
      for (let pass = 1; pass <= MAX_PASSES; pass++) {
        const d = await fetch(`/api/backlinks/${campaignId}/action`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "draft" }),
        }).then((r) => r.json());
        if (!d?.ok) {
          // A failed pass after successful ones still wrote pitches — report both, never just the error.
          toast.error(d?.error ?? "Failed.", { id: progress });
          return pass === 1 ? null : { ...total, remaining: lastRemaining };
        }
        const s = d.draft as Record<string, number>;
        for (const k of Object.keys(s)) {
          if (incremental.includes(k)) total[k] = (total[k] ?? 0) + (s[k] ?? 0);
          else if (k === "alreadyDrafted") { if (pass === 1) total[k] = s[k] ?? 0; }
          else total[k] = s[k] ?? 0;
        }
        const wroteThisPass = incremental.reduce((n, k) => n + (s[k] ?? 0), 0);
        const remaining = s.remaining ?? 0;
        if (selected === campaignId) await loadFunnel(campaignId);
        if (!remaining) break;
        if (!wroteThisPass && remaining >= lastRemaining) {
          // No forward motion: the same prospects failed the same way. Leave `remaining` in the report
          // so the "did not fit" line says how many, rather than looping on them.
          break;
        }
        lastRemaining = remaining;
        const written = incremental.slice(0, 2).reduce((n, k) => n + (total[k] ?? 0), 0);
        toast.loading(`Writing pitches… ${written} written so far, ${remaining} to go (pass ${pass + 1})`, { id: progress });
      }
      return total;
    } finally { toast.dismiss(progress); }
  }

  async function action(act: string, extra?: Record<string, unknown>) {
    if (!selected) return;
    setBusy(act);
    try {
      const d = act === "draft"
        ? await draftAll(selected).then((draft) => (draft ? { ok: true, draft } : { ok: false }))
        : await fetch(`/api/backlinks/${selected}/action`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: act, ...(extra ?? {}) }),
      }).then((r) => r.json());
      if (d?.ok) {
        if (act === "discover") {
          // Say where the prospects came from and how much of the SERP was actually readable.
          // "Found 0" used to be the whole message, which is the least useful version of every
          // different reason it can happen — no candidates, all candidates already ours, a search
          // outage, or no Serper key so the AI Overview was never looked at.
          const r = d.discovery as {
            saved: number; skipped: number; duplicates: number; keywords: string[]; queries: number;
            candidates: number; alreadyKnown: number; bySurface: Record<string, number>;
            aiOverview: { shown: number; checked: number };
            aiAnswers: { enginesUsed: string[]; citedDomains: number; resolvedToArticle: number; siteLevel: number };
            failed: number; notes: string[];
          };
          const aio = (r.bySurface?.ai_overview ?? 0) + (r.bySurface?.ai_answer ?? 0);
          const questions = (r.bySurface?.people_also_ask ?? 0) + (r.bySurface?.things_to_know ?? 0);
          const snippet = r.bySurface?.answer_box ?? 0;
          const where: string[] = [];
          if (aio) where.push(`${aio} cited in an AI answer${r.aiAnswers?.enginesUsed?.length ? ` (${r.aiAnswers.enginesUsed.join(", ")})` : ""}`);
          if (snippet) where.push(`${snippet} cited in a featured snippet`);
          if (questions) where.push(`${questions} from Google's question blocks`);
          const bits: string[] = [];
          bits.push(`${r.queries} search${r.queries === 1 ? "" : "es"} across ${r.keywords.length + 1} keyword${r.keywords.length ? "s" : ""} turned up ${r.candidates} candidate site${r.candidates === 1 ? "" : "s"}`);
          if (where.length) bits.push(`Of the new ones: ${where.join(", ")}`);
          if (r.alreadyKnown) bits.push(`${r.alreadyKnown} candidate${r.alreadyKnown === 1 ? " was" : "s were"} already in this campaign and skipped before ranking, so this run reached further down the list`);
          if (r.candidates > r.saved + r.skipped) bits.push(`${r.candidates - r.saved - r.skipped} more candidate site${r.candidates - r.saved - r.skipped === 1 ? "" : "s"} were found than this run scores — press again to work down the list`);
          if (r.duplicates) bits.push(`${r.duplicates} also appear in another campaign — see the badges in the list`);
          // A site-level prospect is not yet pitchable: the relevance gate reads its homepage and
          // refuses. Naming the remedy here is the difference between that being a step and being
          // a mystery ("judged off-topic") two buttons later.
          if (r.aiAnswers?.siteLevel) bits.push(`${r.aiAnswers.siteLevel} AI-cited site${r.aiAnswers.siteLevel === 1 ? "" : "s"} had no matching article yet — press "Find article URLs" to make ${r.aiAnswers.siteLevel === 1 ? "it" : "them"} pitchable`);
          if (r.failed) bits.push(`${r.failed} candidate${r.failed === 1 ? "" : "s"} could not be filed at all — the reason follows below`);
          const head = r.saved
            ? `Found ${r.saved} new prospect${r.saved === 1 ? "" : "s"}`
            : "No new prospects this run";
          if (r.saved && !r.failed) toast.success(`${head}. ${bits.join(". ")}.`);
          else toast.warning(`${head}. ${bits.join(". ")}.`);
          // The report's own notes go out whenever the run is not a clean success — that is where
          // "no Serper key, so no AI Overview was read", "Gemini answered none of the prompts" and
          // a failed write are actually said.
          if (!r.saved || r.failed) for (const n of (r.notes ?? []).slice(0, 4)) toast.message(n);
        }
        else if (act === "refile-articles") {
          const r = d.refile as { scanned: number; refiled: number; noArticleFound: number; alreadyArticle: number; remaining: number; details: Array<{ domain: string; reason?: string }> };
          const bits: string[] = [];
          if (r.refiled) bits.push(`${r.refiled} now point at a real article — press "Write pitches"`);
          if (r.noArticleFound) bits.push(`${r.noArticleFound} domain(s) have nothing published about this subject, so they are not a fit — see WHY THEM for which`);
          if (r.alreadyArticle) bits.push(`${r.alreadyArticle} already had an article URL`);
          if (r.remaining) bits.push(`${r.remaining} did not fit the time budget — press again`);
          const body = bits.length ? bits.join(". ") + "." : `Nothing to re-file across ${r.scanned} prospect(s).`;
          if (r.refiled) toast.success(body); else toast.warning(body);
        }
        else if (act === "draft") {
          // Account for EVERY prospect, and never claim a reason that is not the real one.
          //
          // This used to have a special case: no pitches written but some already drafted printed
          // "All N contactable prospects already have their pitch — nothing to write." On a campaign
          // of 53 prospects it printed "All 2", because 2 was the already-drafted count and every
          // other skip was thrown away — and the message reads as "there is nothing to do here",
          // which is why it came back as the button being broken.
          //
          // The true breakdown for that campaign: 46 in scope (7 sat in stages the drafter does not
          // touch), 2 already drafted, 44 judged off-topic. `skippedOffTopic` was returned by
          // draftBacklinkPitches all along and used NOWHERE in this file, so the single biggest
          // reason a pitch does not get written was the one reason never shown.
          //
          // Off-topic gets the remedy spelled out because it has one and it is not obvious: in that
          // campaign 43 of 46 prospect URLs were a bare homepage, so the relevance check was reading
          // a plugin sales page or an agency landing page and correctly refusing to pitch it. The
          // gate is right; what is wrong is the saved URL, and re-filing the real article fixes it.
          const s = d.draft as Record<string, number>;
          const wrote = (s.drafted ?? 0) + (s.draftedManual ?? 0);
          const skipped: string[] = [];
          if (s.alreadyDrafted) skipped.push(`${s.alreadyDrafted} already had a pitch`);
          if (s.skippedOffTopic) {
            skipped.push(
              `${s.skippedOffTopic} judged off-topic for this page — see WHY THEM in the list. ` +
              `Usually the saved URL is the site's homepage rather than an article, so re-file the real ` +
              `article URL with "Add from backlinks" and they become pitchable`,
            );
          }
          if (s.skippedNoEmail) skipped.push(`${s.skippedNoEmail} have no email yet — run Find emails`);
          if (s.skippedAngleRewrite) skipped.push(`${s.skippedAngleRewrite} could not be rewritten to this campaign's pitch angle (the rewrite model failed), so they were left undrafted rather than sent out with the standard angle — press again to retry`);
          if (s.skippedRecentContact) skipped.push(`${s.skippedRecentContact} were pitched from another campaign in the last month, so they are held back on purpose`);
          if (s.remaining) skipped.push(`${s.remaining} could not be written this time — press again to retry them`);

          const head = wrote
            ? `Drafted ${s.drafted} pitch${s.drafted === 1 ? "" : "es"}`
              + `${s.draftedSite ? ` — ${s.draftedSite} pitch the site itself (paid guest post) because they have no article to pitch` : ""}`
              + `${s.draftedManual ? ` (+${s.draftedManual} for manual send — form or LinkedIn)` : ""}`
              + `${s.draftedLinkedin ? `, ${s.draftedLinkedin} LinkedIn note${s.draftedLinkedin === 1 ? "" : "s"} — copy them from the pitch dialog` : ""}`
            : "No new pitches were written";
          const body = skipped.length ? `${head}. ${skipped.join(". ")}.` : `${head}.`;
          // Nothing written is not a success, whatever the reason — a green tick on "nothing happened"
          // is what made this look like it had run correctly.
          if (wrote) toast.success(body);
          else toast.warning(body);
        }
        else if (act === "verify") toast.success(`Checked ${d.verify.checked} pages — ${d.verify.live} live link(s).`);
        else if (act === "enrich") toast.success("Looking for emails. This runs in the background — the list will fill in.");
        await loadFunnel(selected); await loadCampaigns();
      } else if (act !== "draft") toast.error(d?.error ?? "Failed."); // draftAll reports its own failure
    } catch (e: any) { toast.error(e?.message ?? "Failed."); }
    finally { setBusy(""); }
  }

  const prospects = funnel?.prospects ?? [];
  const attention = funnel?.attention;
  const count = (pred: (p: Prospect) => boolean) => prospects.filter(pred).length;
  const reached = (stages: string[]) => count((p) => stages.includes(p.stage));

  /** The funnel, as clickable filters. Each step says what it means in plain words, because "ready"
   *  and "sent" are our words, not a marketer's. */
  const steps = useMemo(() => [
    { key: null as string | null, label: "Found", sub: "prospects discovered", icon: Search, n: prospects.length },
    { key: "has-email", label: "Contactable", sub: "have a real address", icon: Mail, n: count((p) => p.emailTrust === "sourced" || p.emailTrust === "verified") },
    { key: "ready", label: "Pitch written", sub: "waiting to send", icon: PenLine, n: reached(["ready", "sent", "replied", "won"]) },
    { key: "sent", label: "Emailed", sub: "pitch has gone out", icon: Send, n: reached(["sent", "replied", "won"]) },
    { key: "replied", label: "Replied", sub: "they wrote back", icon: Inbox, n: reached(["replied", "won"]) },
    { key: "won", label: "Link live", sub: "confirmed on their page", icon: CheckCircle2, n: reached(["won"]) },
  ], [prospects]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(() => {
    let list = prospects;
    if (stageFilter === "has-email") list = list.filter((p) => p.emailTrust === "sourced" || p.emailTrust === "verified");
    else if (stageFilter === "ready") list = list.filter((p) => ["ready", "sent", "replied", "won"].includes(p.stage));
    else if (stageFilter === "sent") list = list.filter((p) => ["sent", "replied", "won"].includes(p.stage));
    else if (stageFilter === "replied") list = list.filter((p) => ["replied", "won"].includes(p.stage));
    else if (stageFilter === "won") list = list.filter((p) => p.stage === "won");

    const rank: Record<EmailTrust, number> = { sourced: 3, verified: 2, guess: 1, none: 0 };
    return [...list].sort((a, b) => {
      if (sortKey === "dr") return (b.dr ?? -1) - (a.dr ?? -1);
      if (sortKey === "email") return rank[b.emailTrust] - rank[a.emailTrust] || (b.score ?? 0) - (a.score ?? 0);
      return (b.score ?? 0) - (a.score ?? 0);
    });
  }, [prospects, stageFilter, sortKey]);

  const needsYou = (attention?.interventions.length ?? 0) + (attention?.awaitingPayment ?? 0) + (attention?.aiPaused ?? 0);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Link2}
        title="Backlink Outreach"
        description="Pick a page to earn links to, then either hand over your own list of articles or let it search. From there the bot finds the writers, pitches them and handles replies; it stops only for what a person has to decide."
      />

      {/* ── Which page are we building links to ─────────────────────────────── */}
      <section className="rounded-2xl border border-[var(--glass-border)] bg-card p-5 space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          {/* Optional. A round aimed at the brand rather than one money page — "alternatives", say —
              has no slug that describes it, and being made to pick one meant picking a wrong one,
              which then set the pitch's subject line and what the verifier looked for. Left blank the
              campaign asks for a link to the site itself. */}
          <div className="space-y-2 flex-1 min-w-[300px]">
            <Label htmlFor="t" className="text-sm">Page you want links to <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <PathCombobox id="t" value={target} onChange={setTarget} options={knownPages}
              placeholder="Leave blank to link to the site itself" />
          </div>
          {/* A name makes the campaign's identity the name, so several campaigns can build links
              to the same page without mixing prospect lists. Blank keeps the old one-per-page rule —
              which is why it stops being optional once no page is chosen: with neither, every
              campaign would resolve to the same row. */}
          <div className="space-y-2 flex-1 min-w-[220px]">
            <Label htmlFor="cn" className="text-sm">
              Campaign name{" "}
              <span className="text-muted-foreground font-normal">{target.trim() ? "(optional)" : "(required — no page chosen)"}</span>
            </Label>
            <Input id="cn" value={campaignName} onChange={(e) => setCampaignName(e.target.value)}
              placeholder='e.g. "Backlink Campaign - Arham"' />
          </div>
          <Button size="lg" onClick={() => void createCampaign(false)} disabled={creating}>
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {creating
              ? (seedUrls.length ? "Reading your articles…" : "Starting…")
              : seedUrls.length
                ? `Start with my ${seedUrls.length} article${seedUrls.length === 1 ? "" : "s"}`
                : "Start campaign"}
          </Button>
        </div>

        {/* Your own articles and keywords, instead of whatever a search of the page's topic turns
            up. Collapsed by default so the common case stays a two-field form.

            flex-col, not space-y: both of the controls below are inline-level, so they sat on one
            line and overlapped each other — the vertical margin space-y adds has nothing to act on
            between two inline boxes. */}
        <div className="flex flex-col items-start gap-3">
          <button type="button" onClick={() => setSeedOpen((v) => !v)}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
            {seedOpen ? "Hide the articles and keywords" : "Bring your own articles or keywords"}
            <span className="font-normal"> (optional)</span>
          </button>

          {seedOpen && (
            <div className="grid w-full gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="sa" className="text-sm">Articles to go after</Label>
                <Textarea id="sa" rows={5} value={seedArticles} onChange={(e) => setSeedArticles(e.target.value)}
                  className="field-sizing-fixed h-32 resize-none overflow-y-auto font-mono text-xs"
                  placeholder={"One URL per line, e.g.\nhttps://site.com/best-ai-video-alternatives"} />
                <p className="text-xs text-muted-foreground">
                  {seedUrls.length
                    ? `${seedUrls.length} URL${seedUrls.length === 1 ? "" : "s"} — we'll read exactly these for their authors and go looking for their emails. Nothing is searched for.`
                    : "Paste the pages you already picked out. We read each one for its author and find their email — no search, no Ahrefs units."}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sk" className="text-sm">Keywords</Label>
                <Textarea id="sk" rows={5} value={seedKeywords} onChange={(e) => setSeedKeywords(e.target.value)}
                  className="field-sizing-fixed h-32 resize-none overflow-y-auto text-sm"
                  placeholder={"One per line, e.g.\nai video generator alternatives\nbest runway alternatives"} />
                <p className="text-xs text-muted-foreground">
                  {seedKws.length
                    ? `${seedKws.length} keyword${seedKws.length === 1 ? "" : "s"} saved on the campaign. Every search from now on uses ${seedKws.length === 1 ? "it" : "them"} instead of guessing from the page's title.`
                    : "Saved on the campaign and used by every later search, instead of guessing the topic from the page's title. Saving them does not start a search."}
                </p>
              </div>
            </div>
          )}

          {/* The old behaviour, now something you ask for. Hidden once articles are pasted: you
              picked the pages, so searching for more of them is not what was meant — and saying so
              is the point, because the previous version searched whether you wanted it or not. */}
          {seedUrls.length ? (
            <p className="text-xs text-muted-foreground">
              Your {seedUrls.length} article{seedUrls.length === 1 ? "" : "s"} {seedUrls.length === 1 ? "is" : "are"} the whole list.
              Choosing a page above does not add web results to it — nothing is searched for unless you ask on the campaign itself.
            </p>
          ) : (
            <Button variant="outline" size="sm" onClick={() => void createCampaign(true)} disabled={creating}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              Start and search the web for prospects
            </Button>
          )}
        </div>

        {campaignsError && (
          <LoadFailed nothing="your campaigns" detail={campaignsError} onRetry={() => void loadCampaigns()} />
        )}
        {campaigns.length > 0 && (() => {
          const mine = campaigns.filter((c) => myEmail && c.created_by === myEmail);
          const scope = scopeChoice ?? (mine.length ? "mine" : "all");
          const shown = scope === "mine" ? mine : campaigns;
          return (
            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-3">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Campaigns</div>
                {/* Only worth a toggle once ownership can actually split the list. */}
                {mine.length > 0 && mine.length < campaigns.length && (
                  <div className="flex gap-1">
                    <Button size="sm" variant={scope === "mine" ? "secondary" : "ghost"} className="h-6 px-2 text-xs"
                      onClick={() => setScopeChoice("mine")}>Mine ({mine.length})</Button>
                    <Button size="sm" variant={scope === "all" ? "secondary" : "ghost"} className="h-6 px-2 text-xs"
                      onClick={() => setScopeChoice("all")}>Everyone ({campaigns.length})</Button>
                  </div>
                )}
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {shown.map((c) => {
                  const live = c.stageCounts.won ?? 0;
                  const on = selected === c.id;
                  return (
                    <button key={c.id} onClick={() => { setSelected(c.id); setStageFilter(null); }}
                      className={cn(
                        "rounded-xl border p-4 text-left transition-colors",
                        on ? "border-highlight bg-highlight-soft" : "border-border hover:bg-accent",
                      )}>
                      <div className="font-medium truncate">{c.name ?? c.target_path}</div>
                      <div className="mt-1 text-sm text-muted-foreground tabular-nums">
                        {c.total} prospect{c.total === 1 ? "" : "s"}
                        {c.name && <span className="truncate"> · {c.target_path}</span>}
                        {live > 0 && <span className="text-success"> · {live} live</span>}
                      </div>
                      {/* Who runs this list — "shared" for pre-ownership campaigns. Mine reads as "you". */}
                      <div className="mt-1 text-xs text-muted-foreground">
                        {myEmail && c.created_by === myEmail ? "you" : ownerLabel(c.created_by)}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })()}
      </section>

      {/* Above the whole funnel block, because on a first-load failure `funnel` is still null and
          nothing below would render — the banner is then the only thing saying why. */}
      {funnelError && (
        <LoadFailed nothing="this campaign's funnel" detail={funnelError} onRetry={() => { if (selected) void loadFunnel(selected); }} />
      )}
      {funnel && (
        <>
          {/* ── Needs you. Shown only when true, so its presence always means something. ────── */}
          {needsYou > 0 && (
            <section className="rounded-2xl border border-warning/40 bg-warning/[0.07] p-5">
              <h2 className="flex items-center gap-2 text-base font-medium">
                <TriangleAlert className="h-5 w-5 text-warning" />
                {needsYou} thing{needsYou === 1 ? "" : "s"} need you
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The bot handles everything else on its own. These it can&apos;t decide.
              </p>
              <div className="mt-4 space-y-2">
                {attention!.awaitingPayment > 0 && (
                  <Link href="/payments" className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:bg-accent transition-colors">
                    <CreditCard className="h-5 w-5 shrink-0 text-warning" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{attention!.awaitingPayment} deal{attention!.awaitingPayment === 1 ? "" : "s"} agreed, waiting on payment</span>
                      <span className="block text-sm text-muted-foreground">Approve and mark paid to close them out.</span>
                    </span>
                  </Link>
                )}
                {attention!.aiPaused > 0 && (
                  <Link href="/inbox" className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:bg-accent transition-colors">
                    <Inbox className="h-5 w-5 shrink-0 text-warning" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{attention!.aiPaused} repl{attention!.aiPaused === 1 ? "y" : "ies"} nobody is answering</span>
                      <span className="block text-sm text-muted-foreground">These threads aren&apos;t AI-managed, so they wait for a person.</span>
                    </span>
                  </Link>
                )}
                {attention!.interventions.map((iv) => {
                  const meta = INTERVENTION_LABEL[iv.type] ?? INTERVENTION_LABEL.other;
                  return (
                    <Link key={iv.id} href="/negotiation" className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 hover:bg-accent transition-colors">
                      <meta.icon className="h-5 w-5 shrink-0 text-warning" />
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{meta.label}{iv.who ? ` — ${iv.who}` : ""}</span>
                        {iv.ask && <span className="block truncate text-sm text-muted-foreground">&ldquo;{iv.ask}&rdquo;</span>}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          {/* ── The funnel, as filters ──────────────────────────────────────────── */}
          <section className="rounded-2xl border border-[var(--glass-border)] bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Progress for {funnel.campaign.name ?? funnel.campaign.target_path}</h2>
              {stageFilter && (
                <Button size="sm" variant="ghost" onClick={() => setStageFilter(null)}>Show all</Button>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
              {steps.map((s) => {
                const on = stageFilter === s.key || (s.key === null && stageFilter === null);
                return (
                  <button key={s.label} onClick={() => setStageFilter(s.key)}
                    className={cn(
                      "rounded-xl border p-4 text-left transition-colors",
                      on ? "border-highlight bg-highlight-soft" : "border-border hover:bg-accent",
                    )}>
                    <s.icon className={cn("h-4 w-4", s.label === "Link live" && s.n > 0 ? "text-success" : "text-muted-foreground")} />
                    <div className={cn("mt-2 text-3xl font-light tabular-nums", s.label === "Link live" && s.n > 0 && "text-success")}>{s.n}</div>
                    <div className="mt-0.5 text-sm font-medium">{s.label}</div>
                    <div className="text-xs text-muted-foreground">{s.sub}</div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* ── What the sends have earned. Shown only once something was sent: rates on zero
                 sends are noise, and the funnel tiles already show the pipeline filling up. ── */}
          {funnel.performance && funnel.performance.sent > 0 && (
            <section className="rounded-2xl border border-[var(--glass-border)] bg-card p-5">
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">What&apos;s working</h2>
              <p className="mt-1.5 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-sm">
                <span><span className="text-2xl font-light tabular-nums">{funnel.performance.sent}</span> sent</span>
                <span>
                  <span className={cn("text-2xl font-light tabular-nums", funnel.performance.replied > 0 && "text-highlight-ink")}>{funnel.performance.replied}</span>
                  {" "}repl{funnel.performance.replied === 1 ? "y" : "ies"}
                  {funnel.performance.replyRate !== null && (
                    <span className="text-muted-foreground"> ({Math.round(funnel.performance.replyRate * 100)}%)</span>
                  )}
                </span>
                {funnel.performance.bounced > 0 && (
                  <span><span className="text-2xl font-light tabular-nums text-warning">{funnel.performance.bounced}</span> bounced</span>
                )}
                <span><span className="text-2xl font-light tabular-nums">{funnel.performance.agreed}</span> agreed</span>
                <span><span className={cn("text-2xl font-light tabular-nums", funnel.performance.won > 0 && "text-success")}>{funnel.performance.won}</span> links live</span>
              </p>
              {/* Per-sender split only when there is a split — one sender's table is just the line above. */}
              {funnel.performance.bySender.length > 1 && (
                <table className="mt-3 text-sm">
                  <tbody>
                    {funnel.performance.bySender.map((s) => (
                      <tr key={s.sender} className="[&>td]:py-0.5 [&>td]:pr-6">
                        <td className="text-muted-foreground">{s.sender.split("@")[0]}</td>
                        <td className="tabular-nums">{s.sent} sent</td>
                        <td className="tabular-nums">{s.replied} replied{s.sent ? ` (${Math.round((s.replied / s.sent) * 100)}%)` : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}

          {/* ── Automation: the global switch, then this campaign's own standing rules. ────── */}
          <AutopilotCard />
          <PolicyCard workflowId={funnel.campaign.workflow_id} label={funnel.campaign.name ?? funnel.campaign.target_path} />
          <SourcingReportCard />

          {/* ── Manual steps, for when you don't want to wait for the schedule ────────────── */}
          <section className="rounded-2xl border border-[var(--glass-border)] bg-card p-5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Run a step now</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Each of these happens on its own once automation is on. Use them to push this campaign along immediately.
            </p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              {/* Repeat presses now reach NEW sites: the domains this campaign already holds are
                  excluded before the candidate list is cut, which is what "find MORE" always
                  implied and never did. */}
              <Button
                size="lg" variant="outline" disabled={!!busy} onClick={() => action("discover")}
                title={
                  "Searches Google for this page's topic" +
                  (funnel.campaign.keywords?.length ? ` and your ${funnel.campaign.keywords.length} saved keyword(s)` : "") +
                  ", reads the whole result page (AI Overview, featured snippet, question blocks) rather than only the ten links, " +
                  "and asks the AI answer engines who they cite. Sites already in this campaign are skipped, so pressing again finds new ones."
                }
              >
                {busy === "discover" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Find more prospects
              </Button>
              <Button size="lg" variant="outline" disabled={!!busy} onClick={() => action("enrich")}>
                {busy === "enrich" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} Find emails
              </Button>
              {/* Between a list of domains and outreach. A prospect added from a domain has the
                  homepage as its article, so the relevance check reads a front page and refuses — every
                  one of them lands as off-topic and no pitch is ever written. This finds a real piece on
                  each domain and clears that verdict. Sits before "Write pitches" because that is the
                  order it has to happen in. */}
              <Button size="lg" variant="outline" disabled={!!busy} onClick={() => action("refile-articles")}>
                {busy === "refile-articles" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Find article URLs
              </Button>
              {/* No mode to pick: one press covers every prospect. The drafter reads each prospect's
                  page and pitches THAT ARTICLE when it fits; a prospect judged to have no article to
                  pitch gets the site pitch (a paid guest post) instead of getting nothing. */}
              <Button
                size="lg" variant="outline" disabled={!!busy} onClick={() => action("draft")}
                title={"Writes a pitch for every contactable prospect in one go: a pitch about their specific article when their page fits this campaign, or a paid guest-post pitch for the site when they have nothing published on our subject."}
              >
                {busy === "draft" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PenLine className="h-4 w-4" />} Write pitches
              </Button>
              {/* The steering wheel for the step to its left. "Write pitches" drafts from the stock
                  paid-collaboration angle; this sets the campaign's OWN angle in the owner's words —
                  sample first, confirm, then applied to every prospect and every later draft. Icon
                  turns highlight when an angle is set, so "why do the pitches read like this" has a
                  visible answer. */}
              <Button
                size="lg" variant="outline" disabled={!!busy} onClick={() => setAngleOpen(true)}
                title={funnel.campaign.pitch_angle
                  ? `This campaign's pitches are written to your angle: "${funnel.campaign.pitch_angle}". Click to change or remove it.`
                  : "Tell the AI what angle to write the pitches from (the default is a paid collaboration). It drafts a sample, you confirm, and it applies to every prospect."}
              >
                <Compass className={cn("h-4 w-4", funnel.campaign.pitch_angle && "text-highlight-ink")} /> Pitch angle
              </Button>
              {/* The step this row was missing. Writing a pitch leaves it 'ready' with no send time,
                  and nothing on this page armed it — so a campaign could sit at "Pitch ready" forever
                  while its author looked for a button that lived on another screen. Sends from the
                  clicking person's own Gmail, so it lands in their Sent box and replies come to them. */}
              <Button size="lg" variant="outline" disabled={!!busy} onClick={scheduleSends}>
                {busy === "send" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Schedule sends
              </Button>
              <Button size="lg" variant="outline" disabled={!!busy} onClick={() => action("verify")}>
                {busy === "verify" ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Check for live links
              </Button>
              {/* Two prospect sources behind one control, because the user's question is the same for
                  both ("here is what I have, find me the authors") and only the input differs. Paste
                  page URLs you already picked in Ahrefs, or just a competitor's domain to have their
                  backlink profile mined. Distinct from "Find more prospects", which goes looking for
                  roundups on its own rather than being told where to look. */}
              <Button size="lg" variant="outline" disabled={!!busy} onClick={() => setPasteOpen(true)}>
                <Plus className="h-4 w-4" /> Add from backlinks
              </Button>
              {/* The supply valve for "Find more prospects" to its left. Discovery derives ONE topic
                  from the target page's title; these are the other terms the same audience searches,
                  in the owner's words, and each seeds the same query set. Icon turns highlight when
                  keywords are saved, so "why is it searching for that" has a visible answer. */}
              <Button
                size="lg" variant="outline" disabled={!!busy}
                onClick={() => { setKwText((funnel.campaign.keywords ?? []).join("\n")); setKwOpen(true); }}
                title={funnel.campaign.keywords?.length
                  ? `Also searching on: ${funnel.campaign.keywords.join(", ")}. Click to change.`
                  : "Add keywords to search alongside this page's own topic — each one finds its own set of link opportunities."}
              >
                <Tags className={cn("h-4 w-4", funnel.campaign.keywords?.length && "text-highlight-ink")} />
                {funnel.campaign.keywords?.length ? `Keywords (${funnel.campaign.keywords.length})` : "Add more keywords"}
              </Button>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-4 text-sm">
              <span className="text-muted-foreground">Open elsewhere:</span>
              <Link href={`/sending?workflow_id=${funnel.campaign.workflow_id}&label=${encodeURIComponent(funnel.campaign.name ?? funnel.campaign.target_path)}`}
                className="flex items-center gap-1.5 text-highlight-ink hover:underline">
                <Send className="h-4 w-4" /> The send queue for this campaign
              </Link>
              <Link href="/inbox" className="flex items-center gap-1.5 text-highlight-ink hover:underline">
                <Inbox className="h-4 w-4" /> Replies
              </Link>
              <Link href="/negotiation" className="flex items-center gap-1.5 text-highlight-ink hover:underline">
                <HandCoins className="h-4 w-4" /> Negotiations
              </Link>
            </div>
          </section>

          {/* ── Prospects ───────────────────────────────────────────────────────── */}
          <section className="rounded-2xl border border-[var(--glass-border)] bg-card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-5">
              <div>
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Prospects{stageFilter ? ` — ${steps.find((s) => s.key === stageFilter)?.label ?? "filtered"}` : ""}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                  Showing {visible.length} of {prospects.length}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Best first by</span>
                {([["score", "Overall fit"], ["dr", "Domain Rating"], ["email", "Email quality"]] as Array<[SortKey, string]>).map(([k, lbl]) => (
                  <Button key={k} size="sm" variant={sortKey === k ? "default" : "outline"} onClick={() => setSortKey(k)}>
                    {sortKey === k && <ArrowUpDown className="h-3.5 w-3.5" />}{lbl}
                  </Button>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground [&>th]:px-5 [&>th]:py-3 [&>th]:text-left [&>th]:font-medium">
                    <th>Site &amp; author</th>
                    <th className="text-right!">Fit</th>
                    <th className="text-right!">DR</th>
                    <th>Email</th>
                    <th>Pitch</th>
                    <th>Stage</th>
                    <th>Why them</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.length === 0 && (
                    <tr><td colSpan={7} className="px-5 py-10 text-center text-muted-foreground">
                      {prospects.length === 0 ? "No prospects yet — use “Find more prospects” above." : "Nothing matches this filter."}
                    </td></tr>
                  )}
                  {visible.map((p) => {
                    const trust = EMAIL_TRUST_LABEL[p.emailTrust];
                    return (
                      <tr key={p.id} className="border-b border-border/60 last:border-0 align-top [&>td]:px-5 [&>td]:py-4">
                        <td className="max-w-[260px]">
                          <a href={p.prospectUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-medium hover:underline">
                            <span className="truncate">{p.domain}</span><ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          </a>
                          {p.author && <div className="mt-0.5 truncate text-muted-foreground">{p.author}</div>}
                          {/* Same-site collision with another campaign. "contacted elsewhere" is the one that
                              matters: a second pitch from the same company reads as spam to the recipient. */}
                          {p.dup && (
                            <Badge
                              variant="outline"
                              className={cn("mt-1 text-xs px-1.5 py-0 h-4", p.dup.contactedAt
                                ? "text-warning border-warning/40"
                                : "text-muted-foreground border-border")}
                              title={p.dup.contactedAt
                                ? `This site was already emailed on ${new Date(p.dup.contactedAt).toLocaleDateString()}` +
                                  `${p.dup.contactedBy ? ` by ${p.dup.contactedBy}` : ""}${p.dup.via ? ` (${p.dup.via})` : ""}. ` +
                                  `A second pitch from us reads as spam — check with them before sending.`
                                : `This site is also in ${p.dup.otherCampaigns.join(", ")}, not contacted there yet. ` +
                                  `Agree who takes it before both lists pitch the same people.`}
                            >
                              {p.dup.contactedAt ? "contacted elsewhere" : "in another campaign"}
                            </Badge>
                          )}
                          {/* Where this one came from. Only the AI-answer surfaces get a badge: they
                              mean Google picked this page as the authority for the query, which is a
                              materially better prospect than one that merely ranks. Organic needs no
                              badge — it is the baseline, and labelling it would make the column noise. */}
                          {(p.discoverySurfaces?.some((s) => s !== "organic") ?? false) && (
                            <Badge
                              variant="outline"
                              className="mt-1 ml-1 h-4 px-1.5 py-0 text-xs text-highlight-ink border-highlight/40"
                              title={`${p.discoveryLabel ?? "found on a Google answer surface"}${p.discoveryQuery ? ` — for the search "${p.discoveryQuery}"` : ""}. Google quotes this page as a source for that query, so a mention here is worth more than a link from a page that only ranks.`}
                            >
                              <Sparkles className="h-3 w-3" />
                              {p.discoverySurfaces.includes("ai_overview") ? "AI Overview"
                                : p.discoverySurfaces.includes("ai_answer") ? "AI answer"
                                : "Google answer"}
                            </Badge>
                          )}
                        </td>
                        <td className="text-right tabular-nums">{p.score ?? "—"}</td>
                        <td className="text-right tabular-nums">{p.dr ?? <span className="text-muted-foreground">—</span>}</td>
                        <td className="max-w-[230px]">
                          {/* No address but a stored manual channel: show the route, not a dead "None yet". */}
                          {!p.email && p.contactChannel === "whatsapp" ? (
                            <>
                              <Badge variant="outline" className="text-xs text-highlight-ink bg-highlight-soft border-highlight/40"
                                title="No address exists, but we have their WhatsApp number. Open the pitch for a chat-ready message.">WhatsApp</Badge>
                              {p.whatsappUrl && (
                                <a href={p.whatsappUrl} target="_blank" rel="noreferrer" className="mt-1 block truncate text-xs text-highlight-ink hover:underline">
                                  {p.whatsappUrl.replace(/^https?:\/\//, "")}
                                </a>
                              )}
                            </>
                          ) : !p.email && p.contactChannel === "form" ? (
                            <>
                              <Badge variant="outline" className="text-xs text-highlight-ink bg-highlight-soft border-highlight/40"
                                title="No address exists, but their site has a contact page. Open the pitch and paste it there.">Contact form</Badge>
                              {p.formUrl && (
                                <a href={p.formUrl} target="_blank" rel="noreferrer" className="mt-1 block truncate text-xs text-highlight-ink hover:underline">
                                  {p.formUrl.replace(/^https?:\/\//, "")}
                                </a>
                              )}
                            </>
                          ) : !p.email && p.contactChannel === "linkedin" ? (
                            <>
                              <Badge variant="outline" className="text-xs text-highlight-ink bg-highlight-soft border-highlight/40"
                                title="No address exists, but we have their LinkedIn. A short DM with the pitch works.">LinkedIn only</Badge>
                              {p.linkedinUrl && (
                                <a href={p.linkedinUrl} target="_blank" rel="noreferrer" className="mt-1 block truncate text-xs text-highlight-ink hover:underline">
                                  {p.linkedinUrl.replace(/^https?:\/\//, "")}
                                </a>
                              )}
                            </>
                          ) : (
                            <>
                              <Badge variant="outline" className={cn("text-xs", trust.cls)} title={trust.hint}>{trust.label}</Badge>
                              {p.email && <div className="mt-1 truncate text-xs text-muted-foreground">{p.email}</div>}
                            </>
                          )}
                        </td>
                        <td>
                          {p.pitch ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setPitchFor(p)}
                              // The unreviewed state is what an operator is scanning for, so it reads as a
                              // prompt rather than a neutral label. 106 pitches had been drafted and none
                              // opened, precisely because nothing pointed at them.
                              className={cn("gap-1.5", !p.pitch.editedAt && p.pitch.editable && "border-primary/40 text-primary")}
                            >
                              <PenLine className="h-3.5 w-3.5" />
                              {p.pitch.editedAt ? "Reviewed" : p.pitch.editable ? "Review" : "View"}
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {p.emailTrust !== "none" ? "not drafted yet"
                                : p.contactChannel === "form" || p.contactChannel === "linkedin" || p.contactChannel === "whatsapp"
                                  ? "pitch is written overnight for manual send"
                                  : "needs an email first"}
                            </span>
                          )}
                        </td>
                        <td>
                          <Badge variant="outline" className={cn("text-xs", STAGE_UI[p.stage]?.cls)}>{STAGE_UI[p.stage]?.label ?? p.stage}</Badge>
                        </td>
                        <td className="max-w-md text-muted-foreground">{p.angle ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {funnel && (
        <PitchAngleDialog
          open={angleOpen}
          onOpenChange={setAngleOpen}
          campaignId={funnel.campaign.id}
          workflowId={funnel.campaign.workflow_id}
          campaignLabel={funnel.campaign.name ?? funnel.campaign.target_path}
          currentAngle={funnel.campaign.pitch_angle ?? null}
          onApplied={() => { if (selected) { void loadFunnel(selected); void loadCampaigns(); } }}
        />
      )}

      <PitchDialog
        open={!!pitchFor}
        onOpenChange={(v) => { if (!v) setPitchFor(null); }}
        target={pitchFor && pitchFor.pitch ? ({
          domain: pitchFor.domain,
          author: pitchFor.author,
          email: pitchFor.email,
          emailOwner: pitchFor.emailOwner,
          emailOwnerPosition: pitchFor.emailOwnerPosition,
          prospectUrl: pitchFor.prospectUrl,
          pitch: pitchFor.pitch,
          workflowId: funnel?.campaign.workflow_id,
          authorId: pitchFor.authorId,
          linkedinUrl: pitchFor.linkedinUrl,
          linkedinNote: pitchFor.linkedinNote,
          linkedinNoteSentAt: pitchFor.linkedinNoteSentAt,
          linkedinNoteSentBy: pitchFor.linkedinNoteSentBy,
          whatsappUrl: pitchFor.whatsappUrl,
          whatsappNote: pitchFor.whatsappNote,
          whatsappNoteSentAt: pitchFor.whatsappNoteSentAt,
          whatsappNoteSentBy: pitchFor.whatsappNoteSentBy,
        } satisfies PitchTarget) : null}
        // Reload so the row's button flips to "Reviewed" straight away. Re-reading the funnel rather than
        // patching local state keeps one source of truth for what the database actually holds.
        onSaved={() => { if (selected) void loadFunnel(selected); }}
      />

      {/* Paste a curated backlink list, get the authors.
          Written for someone who has just copied a column out of an Ahrefs export, so it accepts
          whatever shape that paste arrives in rather than demanding one-per-line. */}
      <Dialog open={pasteOpen} onOpenChange={(v) => { setPasteOpen(v); if (!v) setPasteText(""); }}>
        {/* Laid out as a fixed-height column rather than the default grid: the header, the action
            row and the footnote each keep their space, and only the paste box gives. Whatever is
            pasted, "Find the authors" stays on screen. */}
        <DialogContent className="flex max-h-[calc(100dvh-4rem)] flex-col sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>Add from backlinks</DialogTitle>
            <DialogDescription>
              Paste article URLs you already picked out in Ahrefs, or just a competitor&apos;s domain to
              have us pull their backlinks instead. Either way we read each page, pick up the
              author&apos;s name, and start looking for their email.
            </DialogDescription>
          </DialogHeader>

          <Textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={9}
            // field-sizing-fixed cancels the base Textarea's grow-to-fit. That growth was the bug:
            // a few hundred pasted URLs made the box thousands of pixels tall, which pushed the
            // buttons past the bottom of a centred dialog with nothing to scroll. Here the box is a
            // fixed panel that scrolls its own content, so the paste never changes the layout.
            className="field-sizing-fixed h-56 min-h-0 flex-1 resize-none overflow-y-auto font-mono text-xs"
            placeholder={"https://example.com/blog/best-ai-video-tools\nhttps://another-site.com/reviews/top-editors\n\n...or a single competitor domain:\ninvideo.io"}
          />

          {/* States the mode it has inferred, and for the Ahrefs path says plainly that it spends
              credits — an input that quietly costs money is the one thing this box must not be. */}
          <div className="flex shrink-0 items-center justify-between gap-4 text-sm">
            <span className="text-muted-foreground">
              {pasteIntent.kind === "urls"
                ? `${pasteIntent.count} URL${pasteIntent.count === 1 ? "" : "s"} ready — no Ahrefs credits used`
                : pasteIntent.kind === "domain"
                  ? `Will pull backlinks for ${pasteIntent.domain} (uses Ahrefs credits)`
                  : "Paste page URLs, or one competitor domain"}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => { setPasteOpen(false); setPasteText(""); }}>Cancel</Button>
              <Button onClick={addFromPaste} disabled={pasteIntent.kind === "none" || busy === "paste"}>
                {busy === "paste"
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Reading pages…</>
                  : <>Find the authors</>}
              </Button>
            </div>
          </div>

          <p className="shrink-0 text-xs text-muted-foreground">
            Pages without a visible byline are skipped and reported back, which usually means an
            unsigned post rather than a bad link. Expect that often on the Ahrefs path: most pages
            linking to a tool are unsigned, so a domain typically yields a handful of authors, not one
            per link.
          </p>
        </DialogContent>
      </Dialog>

      {/* Extra seed keywords: the other terms this page's audience searches.
          Written for the person who knows their market better than a page title does — the whole
          point is that "ai video editor" and "text to video" reach different roundups than
          whatever the <title> tag happens to say. */}
      <Dialog open={kwOpen} onOpenChange={(v) => { setKwOpen(v); if (!v) setKwText(""); }}>
        <DialogContent className="flex max-h-[calc(100dvh-4rem)] flex-col sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Keywords to find opportunities for</DialogTitle>
            <DialogDescription>
              One per line. Discovery already searches on this page&apos;s own topic
              {funnel?.campaign.topic ? <> (&ldquo;{funnel.campaign.topic}&rdquo;)</> : null}; each keyword you
              add here searches the same way alongside it, so every one brings its own set of sites.
              Saved on the campaign, so later runs use them too.
            </DialogDescription>
          </DialogHeader>

          <Textarea
            value={kwText}
            onChange={(e) => setKwText(e.target.value)}
            rows={8}
            // Same fixed-panel treatment as the paste box above: a long keyword list scrolls inside
            // the field instead of growing the dialog past its own buttons.
            className="field-sizing-fixed h-48 min-h-0 flex-1 resize-none overflow-y-auto text-sm"
            placeholder={"ai video generator\ntext to video\nai video editor\nfaceswap video"}
          />

          {/* What it will actually do, including the cost, before it is pressed. Four searches per
              keyword is the real number (best X / X tools / top X {year} / X alternatives). */}
          {/* Capped and scrollable for the same reason as the field above — a hundred keywords
              would otherwise turn this preview into the tallest thing in the dialog. */}
          <div className="max-h-32 shrink-0 space-y-2 overflow-y-auto text-sm">
            <div className="text-muted-foreground">
              {kwParsed.length
                ? `${kwParsed.length} keyword${kwParsed.length === 1 ? "" : "s"} — up to ${Math.min(24, (kwParsed.length + 1) * 4)} searches per discovery run, capped at 24.`
                : "No extra keywords — discovery will search on the page's own topic only."}
            </div>
            {kwParsed.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {kwParsed.map((k) => <Badge key={k} variant="outline" className="text-xs">{k}</Badge>)}
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={() => { setKwOpen(false); setKwText(""); }}>Cancel</Button>
            <Button variant="outline" onClick={() => saveKeywords(false)} disabled={busy === "keywords" || busy === "keywords-run"}>
              {busy === "keywords" ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : <>Save for later runs</>}
            </Button>
            <Button onClick={() => saveKeywords(true)} disabled={busy === "keywords" || busy === "keywords-run"}>
              {busy === "keywords-run"
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Searching…</>
                : <><Search className="h-4 w-4" /> Save and find prospects</>}
            </Button>
          </div>

          <p className="shrink-0 text-xs text-muted-foreground">
            Each keyword is worked two ways. It is searched on Google, reading the whole result page
            rather than the ten links — the featured snippet and the &ldquo;People also ask&rdquo; /
            &ldquo;Things to know&rdquo; blocks name sources too, and Google&apos;s own AI Overview is read
            whenever it appears in the response. It is also put to the AI answer engines
            (Gemini&apos;s Google-grounded search, Perplexity), and the pages they cite are added as
            prospects — those are the strongest ones, because an answer engine picked them as the
            authority for the question, and they are often nowhere in the top ten. Every run reports
            which of these actually answered rather than assuming.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
