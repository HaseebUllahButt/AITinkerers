"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Owns page width and padding for every route, so no page has to.
 *
 * Two modes:
 *
 *   reading  — a 1280px measure with 24px padding, for tables, forms and dashboards. Line lengths stay
 *              readable and the left edge is the same on every page.
 *   full     — the whole viewport, for list-plus-detail screens whose two panes need the room, and for
 *              the editors. Capping those at 1280px squeezed the panes into two narrow columns and left
 *              a wide monitor empty.
 *
 * Pages used to add their own max-w and padding inside this container (max-w-3xl, max-w-4xl,
 * max-w-5xl, a 1180px cap, p-6 on top of p-6), so the content's left edge landed at six different
 * x positions across the app. Those overrides are gone; if a page needs a narrower measure for a
 * block of prose, it constrains that block, not the page.
 *
 * Prefix match, so /drafts/<id> and /blog/writer are covered by their parents.
 */
const FULL_WIDTH = [
  "/drafts",
  "/blog",
  "/inbox",
  "/whatsapp",
  "/workflows",
  "/media",
  "/summer",
  "/hermes",
  "/emails",
];

export function PageContainer({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const full = FULL_WIDTH.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  return (
    // Padding lives here rather than on the layout shell so a full-height page keeps h-full/min-h-0
    // working while content still gets its breathing room.
    <div className={cn("mx-auto h-full min-h-0 p-6", full ? "max-w-none" : "max-w-7xl")}>
      {children}
    </div>
  );
}
