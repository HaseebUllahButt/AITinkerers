"use client";

import { useEffect, useState } from "react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { ChevronLeft, ChevronRight, Menu, Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SummitMark } from "@/components/brand/SummitMark";
import { NAV_GROUPS, isNavActive } from "@/lib/nav";

/**
 * The nav itself lives in src/lib/nav.ts, shared with the breadcrumb so a page has one name.
 *
 * Group open/closed state is the user's, and it persists. It used to follow the current route —
 * open if you were inside the group, closed otherwise — which meant the sidebar changed shape on
 * every navigation and the whole map of the app was hidden behind chevrons as soon as you left a
 * section. Now every group starts open, and a group you close stays closed until you open it.
 */
const OPEN_GROUPS_KEY = "summit.sidebar.groups";

// Swaps the nav icon for a spinner while THIS link's navigation is in flight — instant
// feedback on click. Must be rendered inside its <Link> (useLinkStatus reads that context).
function NavIcon({ Icon, collapsed }: { Icon: LucideIcon; collapsed: boolean }) {
  const { pending } = useLinkStatus();
  // Larger in the collapsed rail: there is no label beside it, so the glyph carries all the meaning.
  const cls = cn("shrink-0", collapsed ? "h-5 w-5" : "h-4 w-4 mr-3");
  return pending ? <Loader2 className={cn(cls, "animate-spin")} /> : <Icon className={cls} />;
}

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  /** Groups the user has explicitly closed. Absent means open. */
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(OPEN_GROUPS_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setClosedGroups(JSON.parse(raw));
    } catch {}
  }, []);

  function toggleGroup(label: string) {
    setClosedGroups((g) => {
      const next = { ...g, [label]: !g[label] };
      try { localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  return (
    <>
      <button
        className="lg:hidden fixed top-2.5 left-4 z-50 grid size-9 place-items-center rounded-md border border-border bg-background shadow-sm"
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label="Toggle sidebar"
      >
        <Menu className="h-5 w-5" />
      </button>

      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-30 bg-black/50"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* A flush column against the screen edge with a plain right border. */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex min-h-0 flex-col bg-sidebar border-r border-sidebar-border transition-all duration-300 ease-in-out lg:static lg:z-auto",
          collapsed ? "w-[72px]" : "w-64",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
      >
        {/* Brand row. h-14 to match the top bar exactly — the two bottom borders used to miss by
            8px, a hairline step visible on every screen. */}
        <div className={cn("flex h-14 items-center border-b border-sidebar-border px-4 shrink-0", collapsed && "justify-center px-0")}>
          {!collapsed && (
            <Link href="/" className="flex min-w-0 items-center gap-2.5">
              <SummitMark className="size-7 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium tracking-tight leading-tight">Summit</span>
                <span className="block truncate text-xs text-muted-foreground leading-tight">SEO engine</span>
              </span>
            </Link>
          )}
          {collapsed ? (
            // In the rail there is no room for both the mark and a chevron on one row, so the mark
            // IS the expand control. A native title names it.
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              className="grid size-9 place-items-center rounded-md hover:bg-sidebar-accent"
            >
              <SummitMark className="size-7" />
            </button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-8 w-8 p-0 shrink-0 text-muted-foreground"
              onClick={() => setCollapsed(true)}
              aria-label="Collapse sidebar"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-2">
          {NAV_GROUPS.map((group, gi) => {
            const groupActive = group.items.some((it) => isNavActive(pathname, it));
            // A single-item group has nothing to collapse, so it gets a plain heading.
            const soleItem = group.items.length <= 1;
            const open = collapsed || soleItem || !closedGroups[group.label];
            return (
              <div key={group.label} className={cn(collapsed ? "mb-0" : "mb-1")}>
                {collapsed ? (
                  // A rule between groups, so twenty icons read as four short runs rather than one
                  // undifferentiated column. Skipped above the first group.
                  gi > 0 && <div className="mx-3 my-2 border-t border-sidebar-border/70" aria-hidden="true" />
                ) : soleItem ? (
                  <div className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.label)}
                    className={cn(
                      "w-full flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold uppercase tracking-wide transition-colors",
                      groupActive ? "text-foreground" : "text-muted-foreground",
                      "hover:text-foreground hover:bg-sidebar-accent",
                    )}
                    aria-expanded={open}
                  >
                    <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
                    {group.label}
                    {!open && groupActive && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}
                  </button>
                )}
                {open && (
                  <div className={cn(collapsed ? "space-y-1" : "space-y-0.5")}>
                    {group.items.map((item) => {
                      const active = isNavActive(pathname, item);
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          // Native title is the tooltip in the rail. It is the only label available
                          // once the text is gone, so it is not optional here.
                          title={collapsed ? item.name : undefined}
                          aria-label={collapsed ? item.name : undefined}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "relative flex items-center rounded-lg font-medium transition-colors",
                            collapsed ? "h-10 w-10 mx-auto justify-center" : "ml-2 px-3 py-1.5 text-sm",
                            // The active row is a quiet tinted pane with the accent as text, not a filled
                            // accent block. A filled block made the nav the loudest thing on every screen
                            // and stole the one strong colour from the page's own primary action.
                            active
                              ? "bg-sidebar-accent text-highlight-ink"
                              : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                          )}
                          onClick={() => setMobileOpen(false)}
                        >
                          <NavIcon Icon={item.icon} collapsed={collapsed} />
                          {!collapsed && <span className="truncate">{item.name}</span>}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </div>
    </>
  );
}
