"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

interface NavItem {
  name: string;
  href: string;
  /** Marks an href that would otherwise match as a prefix of its own children. */
  exact?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

// One list. The sidebar renders it and nothing else decides what the app contains, so adding a
// surface is a line here rather than an edit in three files.
const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [{ name: "Dashboard", href: "/dashboard", exact: true }],
  },
  {
    label: "Search",
    items: [
      { name: "Audit", href: "/audit" },
      { name: "Site Audit", href: "/site-audit" },
      { name: "GEO", href: "/geo" },
      { name: "404s", href: "/404s" },
      { name: "SEO ROI", href: "/roi" },
      { name: "Render Lab", href: "/render-lab" },
    ],
  },
  {
    label: "Agent",
    items: [{ name: "Summer", href: "/summer", exact: true }],
  },
  {
    label: "Outreach",
    items: [
      { name: "Backlink Outreach", href: "/backlinks", exact: true },
      { name: "Compose & Send", href: "/emails" },
      { name: "Status", href: "/sending" },
      { name: "Inbox", href: "/inbox" },
      { name: "WhatsApp", href: "/whatsapp" },
    ],
  },
  {
    label: "Content",
    items: [
      { name: "Blogs", href: "/drafts", exact: true },
      { name: "Research", href: "/research" },
      { name: "Assets", href: "/media" },
      { name: "Voices", href: "/blog/voices" },
    ],
  },
  {
    label: "Workspace",
    items: [
      { name: "Handbook", href: "/handbook" },
      { name: "Notifications", href: "/notifications" },
      { name: "Admin", href: "/admin" },
      { name: "Settings", href: "/settings" },
    ],
  },
];

function isActive(pathname: string, item: NavItem): boolean {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
      <Link href="/dashboard" className="block border-b border-border px-5 py-4">
        <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">SearchOps</span>
        <span className="mt-0.5 block text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          SEO · AEO · GEO
        </span>
      </Link>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {NAV.map((group) => (
          <div key={group.label} className="mb-5 last:mb-0">
            <h2 className="px-2 text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{group.label}</h2>
            <ul className="mt-2 space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(pathname, item);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "block px-2 py-1.5 text-sm transition-colors",
                        active
                          ? "bg-sidebar-accent text-primary"
                          : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground",
                      )}
                    >
                      {item.name}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-border px-5 py-3">
        <Link href="/" className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
          ← Home
        </Link>
      </div>
    </aside>
  );
}

/**
 * The same destinations on a narrow screen.
 *
 * A hidden sidebar with no replacement is how a phone visitor ends up with no way to reach half
 * the app, so the groups collapse into one scrollable row rather than disappearing.
 */
export function MobileNav() {
  const pathname = usePathname();
  const items = NAV.flatMap((g) => g.items);

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-border bg-sidebar px-3 py-2 md:hidden">
      {items.map((item) => {
        const active = isActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "whitespace-nowrap px-3 py-1.5 text-sm",
              active ? "bg-sidebar-accent text-primary" : "text-sidebar-foreground",
            )}
          >
            {item.name}
          </Link>
        );
      })}
    </nav>
  );
}
