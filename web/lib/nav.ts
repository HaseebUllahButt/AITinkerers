import {
  Settings,
  Rocket,
  Mail,
  Bell,
  ScanSearch,
  TrendingUp,
  Unlink,
  BrainCircuit,
  Telescope,
  Image as ImageIcon,
  Link2,
  Newspaper,
  Mic2,
  BookOpen,
  Activity,
  Inbox,
  Globe,
  MessageCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * The one list of what Summit's pages are called.
 *
 * The sidebar renders NAV_GROUPS; the breadcrumb resolves a URL segment through ROUTE_LABELS. They
 * used to be two separate lists in two files, which is how the nav came to say "Compose & Send" while
 * the breadcrumb above the same page said "Emails", and how "seo-agents" reached the screen as
 * "Seo-Agents". A page has one name, kept here.
 *
 * Grouped by the job you came here to do, not by when the feature was built:
 *
 *   Agent    — the operator, above the pillars because it can drive all of them
 *   Outreach — start a campaign, compose, watch what's in flight, answer a person
 *   Content  — write and publish
 *   SEO      — audit and grow
 *   Workspace — the room itself
 *
 * `exact` marks a href that would otherwise match as a prefix of its own children, so a parent and a
 * child do not both light up at once.
 */
export interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Agent",
    items: [{ name: "Summer", href: "/summer", icon: BrainCircuit, exact: true }],
  },
  {
    label: "Outreach",
    items: [
      { name: "Backlink Outreach", href: "/backlinks", icon: Link2, exact: true },
      { name: "Compose & Send", href: "/emails", icon: Mail },
      { name: "Status", href: "/sending", icon: Activity },
      { name: "Inbox", href: "/inbox", icon: Inbox },
      { name: "WhatsApp", href: "/whatsapp", icon: MessageCircle },
    ],
  },
  {
    label: "Content",
    items: [
      { name: "Blogs", href: "/drafts", icon: Newspaper, exact: true },
      { name: "Research", href: "/research", icon: Telescope },
      { name: "Assets", href: "/media", icon: ImageIcon },
      { name: "Voices", href: "/blog/voices", icon: Mic2 },
    ],
  },
  {
    label: "SEO",
    items: [
      { name: "SEO ROI", href: "/roi", icon: TrendingUp },
      { name: "Site Audit", href: "/site-audit", icon: ScanSearch },
      { name: "404s", href: "/404s", icon: Unlink },
      { name: "GEO", href: "/geo", icon: Globe },
    ],
  },
  {
    label: "Workspace",
    items: [
      { name: "Handbook", href: "/handbook", icon: BookOpen },
      { name: "Notifications", href: "/notifications", icon: Bell },
      { name: "Admin", href: "/admin", icon: Rocket },
      { name: "Settings", href: "/settings", icon: Settings },
    ],
  },
];

/**
 * Breadcrumb label for a single URL segment.
 *
 * Nav entries come first, keyed by their last path segment, so a page cannot be called two things.
 * The rest are routes that still work by URL but are not offered in the nav (see the comment on
 * NAV_GROUPS in Sidebar history), plus parent segments that are only ever a crumb.
 */
const NAV_SEGMENT_LABELS: Record<string, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.items).map((it) => [it.href.split("/").filter(Boolean).at(-1)!, it.name]),
);

export const ROUTE_LABELS: Record<string, string> = {
  ...NAV_SEGMENT_LABELS,
  // Home
  "": "Prospects",
  // Routes off the nav
  campaigns: "Campaigns",
  workflows: "Workflows",
  "email-finder": "Email Finder",
  negotiation: "Negotiation",
  payments: "Payments",
  "render-lab": "Render Lab",
  writer: "AI Writer",
  // Parent segment of /blog/voices, /blog/writer
  blog: "Blog",
};

/** Human label for one URL segment; falls back to a title-cased segment for anything unlisted. */
export function routeLabel(segment: string): string {
  const known = ROUTE_LABELS[segment];
  if (known) return known;
  return segment
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** Does `pathname` sit inside this nav entry? */
export function isNavActive(pathname: string, item: { href: string; exact?: boolean }): boolean {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}
