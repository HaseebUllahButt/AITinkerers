"use client";

import { useState, useCallback } from "react";
import type { ProspectCard } from "@/lib/types";
import { ProspectDrawer } from "./ProspectDrawer";

// Reusable "click a name → open the full prospect side panel" for any page. Fetches the
// author's full detail (profile + articles + contacts) and renders the shared ProspectDrawer.
// Usage: const { openAuthor, drawer } = useAuthorDrawer();  render {drawer}; onClick={() => openAuthor(id)}
export function useAuthorDrawer() {
  const [prospect, setProspect] = useState<ProspectCard | null>(null);
  const [open, setOpen] = useState(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const openAuthor = useCallback(async (authorId?: string) => {
    if (!authorId) return;
    setLoadingId(authorId);
    const d = await fetch(`/api/authors/${authorId}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    setLoadingId(null);
    if (d) { setProspect(d); setOpen(true); }
  }, []);

  const drawer = <ProspectDrawer prospect={prospect} open={open} onClose={() => setOpen(false)} />;
  return { openAuthor, drawer, loadingId };
}
