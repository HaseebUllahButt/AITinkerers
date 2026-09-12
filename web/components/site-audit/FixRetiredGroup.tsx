"use client";

// Rewrite one retired URL across the blog bodies that carry it.
//
// Sits inside an expanded sweep group, because the group is where the decision is: "what should this
// have pointed at" is a judgement about THIS url, and the corrector cannot make it. That is also why
// there is no "fix everything" button — the destination is different for every group.
//
// Dry run first, always. These are published pages, so there is no draft to review afterwards; the
// preview IS the review. Applying is a second, separate click on a result you have already seen.
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Loader2, Wand2, AlertTriangle, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Edit {
  entry_id: number; slug: string; title: string; links: number;
  urls: Array<{ from: string; to: string; count: number }>;
  sample: { before: string; after: string } | null;
  error: string | null;
}
interface Result {
  ok: boolean; applied: boolean; links: number; entries: number; written: number;
  remaining: number; scanned: number; cap: number;
  edits: Edit[]; warnings: string[]; refusal: string | null;
  failed: Array<{ entry_id: number; slug: string; error: string | null }>;
}

export function FixRetiredGroup({ from, siteWide }: { from: string; siteWide: boolean }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<null | "dry" | "apply">(null);
  const [res, setRes] = useState<Result | null>(null);

  const call = useCallback(async (apply: boolean) => {
    setBusy(apply ? "apply" : "dry");
    try {
      const r = await fetch("/api/url-sweep/correct", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, apply, site_wide: siteWide }),
      });
      const d = (await r.json().catch(() => null)) as Result | null;
      if (!d) { toast.error(`No answer from the server (HTTP ${r.status}).`); return; }
      setRes(d);
      if (d.refusal) { toast.error(d.refusal); return; }
      if (apply) {
        toast.success(`Rewrote ${d.links} link(s) across ${d.written} post(s).`, {
          description: d.remaining ? `${d.remaining} link(s) left — run it again.` : "None left for this URL.",
        });
      }
      for (const w of d.warnings) toast.warning(w, { duration: 8000 });
    } finally { setBusy(null); }
  }, [from, to, siteWide]);

  if (siteWide) {
    return (
      <p className="mt-2 flex items-start gap-1.5 rounded-md border border-highlight/30 bg-highlight-soft/30 p-2 text-xs leading-relaxed">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-highlight" />
        {/* Refusing here, and saying why, beats offering a button that would run and change nothing. */}
        This one is in a shared template in <span className="font-mono">imagine-web</span>, not in page
        content — so it is one code change via a PR there, and rewriting blog bodies would fix nothing.
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-background/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Replace with</span>
        <Input
          value={to} onChange={(e) => setTo(e.target.value)}
          placeholder="/ai-video-generator"
          className="h-7 w-56 text-xs"
        />
        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" disabled={!to.trim() || busy !== null}
          onClick={() => void call(false)}>
          {busy === "dry" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
          Preview the fix
        </Button>
        {res && !res.refusal && res.links > 0 && !res.applied && (
          <Button size="sm" className="h-7 gap-1.5 text-xs" disabled={busy !== null} onClick={() => void call(true)}>
            {busy === "apply" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
            Apply to {res.entries} post(s)
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Blog bodies only, {res?.cap ?? 100} links per run. These pages are live — the preview is the
        review, because there is no draft afterwards.
      </p>

      {res?.refusal && <p className="text-xs leading-relaxed text-destructive">{res.refusal}</p>}

      {res && !res.refusal && (
        <div className="space-y-1">
          <p className="text-xs">
            <b>{res.links}</b> link(s) in <b>{res.entries}</b> post(s)
            {res.remaining > 0 && <> · <span className="text-warning">{res.remaining} left for the next run</span></>}
            {res.applied && <> · <span className="text-success">{res.written} written</span></>}
          </p>
          {res.edits.slice(0, 4).map((e) => (
            <p key={e.entry_id} className="truncate text-xs text-muted-foreground">
              <span className="font-mono">/{e.slug}</span> — {e.links}×{" "}
              {e.urls[0] && <span className="font-mono">{e.urls[0].from} → {e.urls[0].to}</span>}
            </p>
          ))}
          {res.edits.length > 4 && <p className="text-xs text-muted-foreground">…and {res.edits.length - 4} more</p>}
          {res.failed.length > 0 && (
            <p className="text-xs text-destructive">{res.failed.length} post(s) failed to write.</p>
          )}
        </div>
      )}
    </div>
  );
}
