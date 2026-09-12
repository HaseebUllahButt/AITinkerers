"use client";

// The bell, and what is behind it.
//
// ── Two rules it is built around ────────────────────────────────────────────────────────────────
//
// It NEVER opens itself. An interstitial that appears while somebody is mid-sentence in Summer is a
// worse interruption than the thing it is announcing, and people learn to dismiss it unread. The
// badge is the whole ambient signal; opening is always a decision.
//
// The badge counts only what BLOCKS someone — a Summer action waiting on a confirmation, a landing
// page sitting drafted. Drafts and research land in the list to be read, not counted. A permanent
// double-digit badge is the same as no badge, because nobody reads a number that never goes down.

import { useCallback, useEffect, useState } from "react";
import { Bell, FileText, Sparkles, Telescope, LayoutTemplate, AlertCircle, ArrowRight } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface FeedItem {
  id: string;
  kind: "draft" | "awaiting" | "research" | "landing";
  title: string;
  detail: string | null;
  at: string;
  href: string;
  actionable: boolean;
}

const KIND: Record<FeedItem["kind"], { icon: typeof Bell; label: string; tone: string }> = {
  awaiting: { icon: Sparkles, label: "Needs you", tone: "text-highlight-ink" },
  landing: { icon: LayoutTemplate, label: "Landing page", tone: "text-highlight-ink" },
  draft: { icon: FileText, label: "Draft", tone: "text-muted-foreground" },
  research: { icon: Telescope, label: "Research", tone: "text-muted-foreground" },
};

/** Short and unambiguous. "3h" beats "3 hours ago" in a dense list, and a date once it is old. */
function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days <= 7) return `${days}d`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [count, setCount] = useState(0);
  const [degraded, setDegraded] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/feed");
      const r = await res.json().catch(() => null);
      if (r?.ok) {
        setItems(r.items ?? []);
        setCount(r.count ?? 0);
        setDegraded(r.degraded ?? null);
        setFailed(false);
      } else setFailed(true);
    } catch { setFailed(true); }
  }, []);

  // `load` is async: its setState calls land after an await, so this is not the synchronous
  // cascading-render shape the rule targets. Same suppression as the Summer rail and the board.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  // Every two minutes, and only while the tab is visible. A background tab polling forever is a
  // request every two minutes per open SearchOps tab, for a number nobody is looking at.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") void load(); };
    const id = setInterval(tick, 120_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [load]);

  const blocking = items.filter((i) => i.actionable);
  const rest = items.filter((i) => !i.actionable);

  return (
    // An anchored popover, like the avatar menu two buttons to the right. It used to open as a
    // centred modal with a backdrop — the only control in the top bar that took over the screen.
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) void load(); }}>
      <PopoverTrigger
        title={count ? `${count} thing${count === 1 ? "" : "s"} need you` : "Notifications"}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-highlight px-1 text-xs font-semibold leading-none text-primary-foreground">
            {count > 9 ? "9+" : count}
          </span>
        )}
        <span className="sr-only">Notifications</span>
      </PopoverTrigger>

      <PopoverContent align="end" sideOffset={8} className="w-[420px] gap-0 p-0">
        <div className="px-4 pt-4 pb-2">
          <p className="text-sm font-medium">Notifications</p>
          <p className="text-xs text-muted-foreground">
            {count > 0
              ? `${count} thing${count === 1 ? "" : "s"} waiting on someone. The rest is what happened.`
              : "Nothing is waiting on anyone. Here is what happened."}
          </p>
        </div>

        <div className="max-h-[62vh] overflow-y-auto px-2 pb-2 border-t border-border">
          {failed && (
            <p className="mx-2 my-2 flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {/* Not "no notifications" — a failed read and a quiet week are different facts. */}
              <span>Couldn&apos;t load notifications. This is <b>not</b> an empty list.</span>
            </p>
          )}
          {degraded && (
            <p className="mx-2 my-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              Partial feed — {degraded}
            </p>
          )}

          {!failed && items.length === 0 && (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              Nothing in the last seven days.
            </p>
          )}

          {blocking.length > 0 && <Section title="Waiting on someone" items={blocking} onGo={() => setOpen(false)} />}
          {rest.length > 0 && <Section title="Recent" items={rest} onGo={() => setOpen(false)} />}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({ title, items, onGo }: { title: string; items: FeedItem[]; onGo: () => void }) {
  return (
    <div className="mb-1">
      <p className="px-3 pb-1 pt-3 text-xs uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="flex flex-col">
        {items.map((it) => {
          const k = KIND[it.kind];
          const Icon = k.icon;
          return (
            <a
              key={it.id}
              href={it.href}
              onClick={onGo}
              className="group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-accent/50"
            >
              <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", k.tone)} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{it.title}</span>
                  <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{ago(it.at)}</span>
                </span>
                {it.detail && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{it.detail}</span>}
              </span>
              <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </a>
          );
        })}
      </div>
    </div>
  );
}
