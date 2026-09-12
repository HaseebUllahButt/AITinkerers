"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

// Thin top progress bar shown on every route change — covers the window where a client
// page has mounted but is still fetching its data (which is when its own skeletons show),
// so navigation always has a visible "loading" cue. Pairs with the sidebar link spinners.
export function RouteProgress() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const first = useRef(true);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (first.current) { first.current = false; return; } // don't flash on initial load
    timers.current.forEach(clearTimeout);
    setVisible(true);
    // Hold briefly to overlap the new page's initial data fetch, then fade out.
    timers.current = [setTimeout(() => setVisible(false), 800)];
    return () => timers.current.forEach(clearTimeout);
  }, [pathname]);

  return (
    <div
      aria-hidden
      className={`fixed top-0 left-0 right-0 z-[60] h-0.5 transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0"}`}
    >
      <div className={`h-full bg-primary ${visible ? "animate-[route-bar_0.8s_ease-out]" : ""}`} />
      <style>{`@keyframes route-bar{0%{width:0%}30%{width:55%}70%{width:82%}100%{width:100%}}`}</style>
    </div>
  );
}
