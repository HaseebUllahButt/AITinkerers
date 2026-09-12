import { NextResponse } from "next/server";

import { auth } from "@auth";
import { supabaseAdmin } from "@/lib/db/supabase";
import { attributionFor, isMachineMade } from "@/lib/blog/origin";

export const maxDuration = 20;

/**
 * What the team should know about right now.
 *
 * ── Why one endpoint and not four ───────────────────────────────────────────────────────────────
 *
 * The bell shows ONE number. If the count and the list came from different requests they would
 * disagree the moment anything changed between them, and a badge saying 3 above a list of 5 is
 * worse than no badge — it teaches people the number is decorative.
 *
 * ── What counts as a notification ───────────────────────────────────────────────────────────────
 *
 * Only things a PERSON has to act on, or would want to know landed. Deliberately not: every draft
 * edit, every sweep that found nothing, every automated run that succeeded. A feed that reports
 * routine success is one people stop opening, and then the item that mattered is buried in it.
 *
 * The window is seven days. Older than that and it is not news, it is the backlog — which already
 * has its own surfaces (/drafts, /research).
 */

const WINDOW_DAYS = 7;

export interface FeedItem {
  id: string;
  kind: "draft" | "awaiting" | "research";
  title: string;
  detail: string | null;
  at: string;
  href: string;
  /** Needs a person to do something, as opposed to merely having happened. Drives the count. */
  actionable: boolean;
}

export async function GET() {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const items: FeedItem[] = [];
  const problems: string[] = [];

  // Each source is independent: one unreadable table degrades the feed, it must never empty it.
  const [drafts, actions, research] = await Promise.allSettled([
    supabaseAdmin.from("blog_drafts")
      .select("id, title, slug, created_by, created_at, sync_state")
      .gte("created_at", since).order("created_at", { ascending: false }).limit(20),
    supabaseAdmin.from("hermes_actions")
      .select("id, session_id, kind, summary, proposed_at")
      .eq("status", "proposed").gte("proposed_at", since)
      .order("proposed_at", { ascending: false }).limit(20),
    supabaseAdmin.from("research_items")
      .select("id, subject, source_name, surfaces, last_seen, coverage")
      .eq("status", "open").eq("coverage", "open").gte("last_seen", since)
      .order("last_seen", { ascending: false }).limit(15),
  ]);

  if (drafts.status === "fulfilled" && !drafts.value.error) {
    for (const d of drafts.value.data ?? []) {
      const who = attributionFor(d.created_by) ?? "";
      items.push({
        id: `draft:${d.id}`,
        kind: "draft",
        title: d.title || "Untitled draft",
        detail: `${isMachineMade(d.created_by) ? `From ${who}` : `By ${who.split("@")[0]}`} · ${d.sync_state === "synced" ? "in Strapi" : "in SearchOps"}`,
        at: d.created_at,
        href: "/drafts",
        // A draft is news, not a task — it is read when somebody has time. Counting every one would
        // put a permanent double-digit badge on the bell and make the number meaningless.
        actionable: false,
      });
    }
  } else problems.push("drafts");

  if (actions.status === "fulfilled" && !actions.value.error) {
    for (const a of actions.value.data ?? []) {
      items.push({
        id: `action:${a.id}`,
        kind: "awaiting",
        title: "Summer is waiting on you",
        detail: a.summary || a.kind,
        at: a.proposed_at,
        href: "/summer",
        // This one genuinely blocks: a proposed action sits there until a person confirms or
        // rejects it, and nothing else in the tool will move it.
        actionable: true,
      });
    }
  } else problems.push("summer");

  if (research.status === "fulfilled" && !research.value.error) {
    for (const r of research.value.data ?? []) {
      items.push({
        id: `research:${r.id}`,
        kind: "research",
        title: r.subject,
        detail: `${r.source_name ?? "research"} · ${Array.isArray(r.surfaces) && r.surfaces.includes("landing") ? "page + blog" : "blog"}`,
        at: r.last_seen,
        href: "/research",
        actionable: false,
      });
    }
  } else problems.push("research");

  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return NextResponse.json({
    ok: true,
    items: items.slice(0, 40),
    // The badge counts ACTIONABLE items only. Everything else is in the list to read.
    count: items.filter((i) => i.actionable).length,
    total: items.length,
    // Reported so a partial feed is visible as partial. A silently missing source reads as a quiet
    // week, and the two need to look different.
    degraded: problems.length ? `Could not read: ${problems.join(", ")}.` : null,
  });
}
