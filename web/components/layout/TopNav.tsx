"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { routeLabel } from "@/lib/nav";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * A path segment that is a record id rather than a page.
 *
 * /drafts/<uuid> put "E950266d-A248-486b-B0e3-5578c2c8f327" in the breadcrumb — title-cased by the
 * `capitalize` class, which made a meaningless string look like a rendering bug on top of being
 * meaningless. A breadcrumb is for navigating back up, and there is nothing above a record's own id.
 *
 * Matches UUIDs and long hex/opaque tokens. Deliberately narrow: a real page slug like
 * "ai-image-generator" has vowels and short words, so it can never be mistaken for one of these.
 */
function isOpaqueId(seg: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) ||
    /^[0-9a-f]{16,}$/i.test(seg)
  );
}

export function TopNav() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();

  const segments = pathname.split("/").filter(Boolean);
  const user = session?.user;

  // A flat bar with a hairline bottom border, the same height as the sidebar's brand row so the two
  // borders meet as one line.
  return (
    <header className="z-30 flex h-14 shrink-0 items-center border-b border-border bg-background">
      <div className="flex h-full w-full items-center justify-between px-6 pl-16 lg:pl-6">
        {/* Breadcrumb. Labels come from the same list the sidebar renders, so the crumb and the nav
            never call one page two different things. */}
        <nav className="flex items-center gap-1.5 text-sm">
          <Link href="/" className="text-muted-foreground hover:text-foreground transition-colors font-medium">
            SearchOps
          </Link>
          {segments.filter((s) => !isOpaqueId(s)).map((seg, i, kept) => (
            <span key={seg} className="flex items-center gap-1.5">
              <span className="text-muted-foreground">/</span>
              <Link
                // Rebuilt from the KEPT segments, not the original index — dropping a segment and
                // then slicing the raw path would link "Drafts" at /drafts/<uuid>, i.e. back to the
                // page you are already on.
                href={"/" + kept.slice(0, i + 1).join("/")}
                className="text-foreground font-medium"
              >
                {routeLabel(seg)}
              </Link>
            </span>
          ))}
        </nav>

        {/* Right side: theme toggle, then the avatar. */}
        <div className="flex items-center gap-2">
          {/* Theme toggle */}
          <Button
            variant="ghost"
            size="sm"
            className="h-9 w-9 p-0"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            <span className="sr-only">Toggle theme</span>
          </Button>

          {/* User dropdown */}
          {user && (
            <DropdownMenu>
              <DropdownMenuTrigger className="rounded-full focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
                <Avatar className="h-8 w-8">
                  <AvatarImage src={user.image ?? undefined} alt={user.name ?? ""} />
                  <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">
                    {user.name?.[0]?.toUpperCase() ?? user.email?.[0]?.toUpperCase() ?? "U"}
                  </AvatarFallback>
                </Avatar>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col gap-0.5">
                    <p className="text-sm font-medium leading-none">{user.name}</p>
                    <p className="text-xs text-muted-foreground leading-none mt-1">{user.email}</p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => signOut({ callbackUrl: "/login" })}
                >
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </header>
  );
}
