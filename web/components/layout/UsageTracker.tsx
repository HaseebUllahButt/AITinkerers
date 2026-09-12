"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Records which surface the current user is on, once per route change.
 *
 * Mounted once in the root layout, so it covers all 22 pages without any of them knowing about it —
 * the alternative was a hook call in every page, which is 22 chances to forget one and then wonder why
 * a surface looks unused.
 *
 * `keepalive` matters: a route change unmounts this component and can cancel an in-flight fetch, which
 * would drop exactly the navigation we are trying to record. Failures are swallowed entirely — usage
 * tracking that can break a page is worse than usage tracking that occasionally misses a row, and the
 * server already de-duplicates per hour so a retry would be pointless.
 */
export function UsageTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    // Only the top-level nav surfaces are tracked; the server allow-lists them anyway, so sending a
    // sub-route would just be a wasted round trip.
    const surface = pathname === "/" ? "/" : pathname.replace(/\/$/, "");
    fetch("/api/usage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "view", surface }),
      keepalive: true,
    }).catch(() => {});
  }, [pathname]);

  return null;
}
