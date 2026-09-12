import {
  LayoutDashboard,
  ScanSearch,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * The one list of what SearchOps's pages are called.
 *
 * The sidebar renders NAV_GROUPS; the breadcrumb resolves a URL segment through ROUTE_LABELS. A
 * page has one name, kept here, so the nav and the crumb can never disagree.
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
    label: "SearchOps",
    items: [
      { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, exact: true },
      { name: "Audit", href: "/audit", icon: ScanSearch, exact: true },
    ],
  },
];

/**
 * Breadcrumb label for a single URL segment.
 *
 * Nav entries come first, keyed by their last path segment, so a page cannot be called two things.
 */
const NAV_SEGMENT_LABELS: Record<string, string> = Object.fromEntries(
  NAV_GROUPS.flatMap((g) => g.items).map((it) => [it.href.split("/").filter(Boolean).at(-1)!, it.name]),
);

export const ROUTE_LABELS: Record<string, string> = {
  ...NAV_SEGMENT_LABELS,
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
