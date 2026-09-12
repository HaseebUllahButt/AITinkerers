"use client";

import { useEffect, useState } from "react";

/** Every money-page path from the live sitemap — backs the "pick a page" pickers. */
export function useKnownPages(): string[] {
  const [paths, setPaths] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/sitemap/paths").then((r) => (r.ok ? r.json() : null)).then((d) => {
      if (d?.ok) setPaths(d.paths);
    }).catch(() => {});
  }, []);
  return paths;
}
