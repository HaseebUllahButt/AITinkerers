"use client";

// Generate an image, from wherever an image is being added.
//
// ── Why this lives inside the picker rather than beside it ──────────────────────────────────────
//
// The picker is already the ONE surface every image slot goes through — cover, thumbnail and inline
// all open it. Adding generation as a fourth route in (after gallery, upload and paste-a-URL) means
// every slot gets it from a single integration, and no slot can be forgotten later.
//
// ── It uses the same brain as everything else ───────────────────────────────────────────────────
//
// POST /api/media/generate in its single-asset mode, which is the same path the asset pipeline uses:
// SIZE_PRESETS for the role, buildImagePrompt with the STYLE_AXES the reference set was distilled
// into, the learned imagery standing-rules read fresh on every request, and GPT Image 2. Nothing
// here re-implements a prompt — a second prompt builder would drift from the first within a week,
// and the art direction is the part that took the longest to get right.
//
// `role` is load-bearing rather than cosmetic: it picks the dimensions AND whether type is allowed
// on the image at all. A thumbnail is a social card and carries a headline; a body image must not,
// because Google cannot read baked-in text and it is illegible at mobile width.

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles, Upload, X, Link2, ImageIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export type GenRole = "hero" | "thumbnail" | "inline" | "og";

interface GeneratedAsset {
  id: string;
  url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}

/** What each slot is FOR, in the words a person would use. Also says where type is allowed, because
 *  that surprises people who ask for a headline on a body image and get none. */
const ROLE_NOTE: Record<GenRole, string> = {
  hero: "1600×900, the image at the top of the article. No baked-in text.",
  thumbnail: "1200×630 social card. This one may carry a short headline.",
  og: "1200×630 share card. May carry a short headline.",
  inline: "1200×675 body image. No baked-in text — Google cannot read it.",
};

export function ImageGenerator({
  role, defaultSubject, draftId, onPick,
}: {
  role: GenRole;
  /** The draft's title, so the field is never empty on a page that already knows its subject. */
  defaultSubject?: string;
  /** Attaches the asset to the draft when present, the same way the pipeline does. */
  draftId?: string | null;
  onPick: (asset: { url: string; alt: string; width?: number | null; height?: number | null }) => void;
}) {
  const [subject, setSubject] = useState(defaultSubject ?? "");
  const [direction, setDirection] = useState("");
  const [refs, setRefs] = useState<string[]>([]);
  const [refUrl, setRefUrl] = useState("");
  const [count, setCount] = useState(2);
  const [busy, setBusy] = useState(false);
  const [uploadingRef, setUploadingRef] = useState(false);
  const [results, setResults] = useState<GeneratedAsset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refInput = useRef<HTMLInputElement>(null);

  /**
   * A reference has to be a PUBLIC url — fal fetches it server-side and cannot reach localhost, and
   * a large data URI makes it reject its own input. So an uploaded file goes through the normal
   * media upload first and the hosted URL is what gets sent.
   */
  const addRefFile = useCallback(async (file: File) => {
    setUploadingRef(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("alt", "reference");
      const d = await fetch("/api/blog/upload", { method: "POST", body: fd }).then((r) => r.json());
      if (!d?.ok || !d.url) { toast.error(d?.error ?? "Couldn't upload that reference."); return; }
      setRefs((r) => (r.length >= 6 ? r : [...r, d.url as string]));
    } catch {
      toast.error("Couldn't upload that reference.");
    } finally { setUploadingRef(false); }
  }, []);

  const generate = useCallback(async () => {
    const s = subject.trim();
    if (!s) { toast.error("Say what the image should show."); return; }
    setBusy(true);
    setError(null);
    setResults([]);
    try {
      const res = await fetch("/api/media/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role, subject: s, topic: s, title: defaultSubject || s,
          direction: direction.trim() || undefined,
          image_urls: refs,
          count,
          ...(draftId ? { draft_id: draftId } : {}),
        }),
      });
      const d = await res.json().catch(() => null);
      if (!d?.ok) {
        // The route reports a content-policy refusal as a normal, explained failure rather than a
        // fault — surfacing its own words is more useful than "generation failed".
        setError(d?.error ?? `Generation failed (HTTP ${res.status}).`);
        return;
      }
      const assets = (d.assets ?? []) as GeneratedAsset[];
      if (!assets.length) {
        setError("The model returned no image. That usually means the prompt was refused — try describing it differently.");
        return;
      }
      setResults(assets);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed.");
    } finally { setBusy(false); }
  }, [subject, direction, refs, count, role, draftId, defaultSubject]);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-xs font-medium">What should the image show?</label>
        <Textarea
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          rows={2}
          placeholder="A few words. The house art direction is applied on top — you do not need to describe the style."
          className="text-sm"
        />
        <p className="text-xs text-muted-foreground">{ROLE_NOTE[role]}</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium">
          Art direction <span className="font-normal text-muted-foreground">optional</span>
        </label>
        <Input
          value={direction}
          onChange={(e) => setDirection(e.target.value)}
          placeholder="Plain words — “warmer light”, “less purple”, “shot from below”"
          className="text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium">
          Reference images <span className="font-normal text-muted-foreground">optional, up to 6</span>
        </label>
        <div className="flex items-center gap-2">
          <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            value={refUrl}
            onChange={(e) => setRefUrl(e.target.value)}
            placeholder="Paste an image URL to match"
            className="flex-1 text-sm"
          />
          <Button
            size="sm" variant="outline"
            disabled={!/^https?:\/\//i.test(refUrl.trim()) || refs.length >= 6}
            onClick={() => { setRefs((r) => [...r, refUrl.trim()]); setRefUrl(""); }}
          >
            Add
          </Button>
          <input ref={refInput} type="file" accept="image/*" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void addRefFile(f); e.target.value = ""; }} />
          <Button size="sm" variant="outline" disabled={uploadingRef || refs.length >= 6}
            onClick={() => refInput.current?.click()} title="Upload a reference from this computer">
            {uploadingRef ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          </Button>
        </div>
        {refs.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {refs.map((u) => (
              <span key={u} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u} alt="reference" className="h-12 w-16 rounded border border-border object-cover" />
                <button
                  type="button"
                  onClick={() => setRefs((r) => r.filter((x) => x !== u))}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-background/90 p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">How many</span>
        {[1, 2, 4].map((n) => (
          <button key={n} type="button" onClick={() => setCount(n)}
            className={cn("h-7 w-8 rounded-md text-xs transition-colors",
              count === n ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}>
            {n}
          </button>
        ))}
        <Button className="ml-auto gap-1.5" onClick={generate} disabled={busy || !subject.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {busy ? "Generating…" : "Generate"}
        </Button>
      </div>

      {busy && (
        // Said plainly, because a 4K render genuinely takes minutes and a silent spinner reads as a
        // hang. Naming the model is not decoration: it is what someone needs to know when an image
        // comes back in a style they did not expect.
        <p className="text-xs text-muted-foreground">
          GPT Image 2, {count} image{count === 1 ? "" : "s"} at the {role} size. This can take a minute or two.
        </p>
      )}

      {error && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">{error}</p>
      )}

      {results.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Click one to use it. The rest stay in the gallery.</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {results.map((a) => (
              <button key={a.id} type="button"
                onClick={() => onPick({ url: a.url, alt: a.alt ?? subject.trim(), width: a.width, height: a.height })}
                className="group overflow-hidden rounded-lg border border-border text-left transition-colors hover:border-highlight/60">
                <span className="relative block aspect-[16/10] bg-muted/40">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.url} alt={a.alt ?? ""} className="absolute inset-0 h-full w-full object-cover" />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!busy && results.length === 0 && !error && (
        <div className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <ImageIcon className="h-3.5 w-3.5 shrink-0" />
          <span>Generated images are saved to the gallery, so nothing is lost if you close this.</span>
        </div>
      )}
    </div>
  );
}
