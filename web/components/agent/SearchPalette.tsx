"use client";

// Conversation search — ⌘K over titles AND message bodies.
//
// Built on the repo's existing cmdk wrapper rather than a bespoke modal, so it inherits the focus
// trap, the escape handling and the arrow-key/Enter semantics people already expect from a palette.
//
// ══ Two decisions worth keeping ═════════════════════════════════════════════════════════════════
//
//  1. `shouldFilter={false}`. cmdk's default is to fuzzy-filter the rendered items client-side,
//     which is exactly wrong here: the server has already ranked these (title matches above body
//     matches, then hit count, then recency) and it searched text the client never sees. Leaving
//     the local filter on would silently drop rows whose match lives in the body — the whole point
//     of the feature — because the title does not contain the term.
//
//  2. The result list is keyed by session id and cmdk's `value` is the id, not the title. Titles
//     repeat constantly here ("Untitled", three chats that all start "what are some upcoming
//     genai models…"), and duplicate values make cmdk highlight the wrong row on arrow-down.

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, Search } from "lucide-react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

/** Mirrors HermesSearchHit in src/lib/db/queries.ts. */
interface SearchHit {
  session_id: string;
  title: string | null;
  project_id: string | null;
  updated_at: string;
  in_title: boolean;
  hits: number;
  snippet: string | null;
}

export interface SearchPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen conversation's id. The page opens it and closes the palette. */
  onSelect: (sessionId: string) => void;
  /** Whose conversations to search. null/omitted = your own. Superuser only; the route refuses
   *  anyone else, so passing it from a non-superuser page simply 403s rather than leaking. */
  viewingAs?: string | null;
}

/** Debounce. Long enough that typing a word is one request, short enough to feel live. */
const DEBOUNCE_MS = 180;
/** Below this the term matches nearly everything and the list is noise. Mirrors the server floor. */
const MIN_TERM = 2;

/**
 * Split a string on the search term, case-insensitively, so the match can be marked.
 *
 * Returns segments rather than HTML: building a string with <mark> in it would mean
 * dangerouslySetInnerHTML over content that includes whatever anyone ever typed into a chat.
 */
function markMatch(text: string, term: string): { text: string; hit: boolean }[] {
  if (!term) return [{ text, hit: false }];
  const out: { text: string; hit: boolean }[] = [];
  const hay = text.toLowerCase();
  const needle = term.toLowerCase();
  let i = 0;
  for (;;) {
    const at = hay.indexOf(needle, i);
    if (at === -1) {
      if (i < text.length) out.push({ text: text.slice(i), hit: false });
      return out;
    }
    if (at > i) out.push({ text: text.slice(i, at), hit: false });
    out.push({ text: text.slice(at, at + needle.length), hit: true });
    i = at + needle.length;
  }
}

/** Centre the snippet on the match — a 240-char excerpt whose hit is at character 200 reads as a miss. */
function centreOnMatch(snippet: string, term: string, radius = 90): string {
  const at = snippet.toLowerCase().indexOf(term.toLowerCase());
  if (at <= radius) return snippet;
  return `…${snippet.slice(Math.max(0, at - radius))}`;
}

export function SearchPalette({ open, onOpenChange, onSelect, viewingAs = null }: SearchPaletteProps) {
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);

  // Guards an out-of-order response overwriting a newer one: type fast enough and a slow request
  // for "gen" can land after the quick one for "genai" and repopulate the list with stale rows.
  const seq = useRef(0);

  useEffect(() => {
    const q = term.trim();
    // Below the floor there is nothing to fetch AND nothing to clear: `visibleHits` derives the
    // empty list from `q` (below), so this effect never has to write state to represent "too
    // short". That also keeps every setState in this component inside the async callback —
    // a synchronous setState in an effect body triggers a cascading render, which React 19's
    // `react-hooks/set-state-in-effect` rule exists to stop.
    if (q.length < MIN_TERM) return;
    const mine = ++seq.current;
    const ctrl = new AbortController();
    const t = window.setTimeout(async () => {
      setLoading(true);
      try {
        // Search follows whoever the rail is showing. Without this, searching while reading a
        // colleague's conversations would quietly return YOUR results under their rail — the worst
        // kind of wrong, because every row looks plausible.
        const scope = viewingAs ? `&as=${encodeURIComponent(viewingAs)}` : "";
        const res = await fetch(`/api/hermes/search?q=${encodeURIComponent(q)}${scope}`, { signal: ctrl.signal });
        const json = await res.json().catch(() => null);
        if (mine !== seq.current) return; // a newer keystroke already won
        setHits(json?.ok ? (json.hits as SearchHit[]) : []);
      } catch {
        if (mine === seq.current) setHits([]);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [term, viewingAs]);

  /**
   * Reset on close — in the event, not in an effect.
   *
   * Reopening onto the previous query and its now-stale results reads as a bug. Doing it in an
   * effect keyed on `open` would be a synchronous setState in an effect (a cascading render); the
   * close IS an event, so it belongs here.
   */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setTerm("");
        setHits([]);
      }
      onOpenChange(next);
    },
    [onOpenChange],
  );

  const choose = useCallback(
    (id: string) => {
      onSelect(id);
      handleOpenChange(false);
    },
    [onSelect, handleOpenChange],
  );

  const q = term.trim();
  // Derived, not stored — see the effect above.
  const visibleHits = q.length < MIN_TERM ? [] : hits;

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title="Search conversations"
      description="Search your chats by title or by what was said in them"
      className="max-w-2xl"
    >
      {/* This repo's CommandDialog renders children straight into DialogContent — unlike stock
          shadcn it does NOT wrap them in <Command>. So the provider goes here, which is also the
          only place `shouldFilter` can legally live (spreading it on CommandDialog would forward an
          unknown prop to Dialog and on to the DOM). */}
      <Command shouldFilter={false} className="bg-transparent p-0 backdrop-blur-none">
      <CommandInput
        value={term}
        onValueChange={setTerm}
        placeholder="Search conversations…"
      />
      <CommandList className="max-h-[60vh]">
        {q.length < MIN_TERM ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            <Search className="mx-auto mb-2 h-5 w-5 opacity-50" aria-hidden />
            Search by title, or by anything said in a conversation.
          </div>
        ) : loading && visibleHits.length === 0 ? (
          // A spinner for a 180ms debounce would strobe; a settled line does not.
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">Searching…</div>
        ) : (
          <>
            <CommandEmpty>No conversation mentions “{q}”.</CommandEmpty>
            {visibleHits.length > 0 ? (
              <CommandGroup heading={`${visibleHits.length} conversation${visibleHits.length === 1 ? "" : "s"}`}>
                {visibleHits.map((h) => {
                  const title = h.title?.trim() || "Untitled";
                  const snippet = h.snippet ? centreOnMatch(h.snippet, q) : null;
                  return (
                    <CommandItem
                      key={h.session_id}
                      value={h.session_id}
                      onSelect={() => choose(h.session_id)}
                      className="flex-col items-start gap-1 py-2.5"
                    >
                      <div className="flex w-full min-w-0 items-center gap-2">
                        <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate text-xs font-medium">
                          {markMatch(title, q).map((seg, i) => (
                            <span key={i} className={cn(seg.hit && "text-primary")}>
                              {seg.text}
                            </span>
                          ))}
                        </span>
                        {/* Only when the body matched too — on a title-only hit it would read as
                            "1 mention" of a conversation the user is already looking at. */}
                        {h.hits > 0 ? (
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                            {h.hits} {h.hits === 1 ? "mention" : "mentions"}
                          </span>
                        ) : null}
                      </div>
                      {snippet ? (
                        <p className="line-clamp-2 pl-5.5 text-xs leading-relaxed text-muted-foreground">
                          {markMatch(snippet, q).map((seg, i) => (
                            <span key={i} className={cn(seg.hit && "text-foreground")}>
                              {seg.text}
                            </span>
                          ))}
                        </p>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
          </>
        )}
      </CommandList>
      </Command>
    </CommandDialog>
  );
}

/**
 * ⌘K / Ctrl+K to open, from anywhere on the page.
 *
 * Ignores the shortcut while focus is in a text field, so ⌘K inside the composer does not steal a
 * half-typed message away behind a modal.
 */
export function useSearchHotkey(onOpen: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLInputElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
}
