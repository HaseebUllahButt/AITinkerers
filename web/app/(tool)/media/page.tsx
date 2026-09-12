"use client";

// Image assets: generate them, and browse everything ever made.
//
// The gallery is the point. Generation produces rejects — you ask for four variants and keep one — so
// the useful artifact is a searchable history you can pull from anywhere an image is needed, not a
// one-shot generate button. That is also why assets live in our own table rather than being pushed
// straight into Strapi's media library: rejects would fill the CMS forever.
//
// Everything here except the actual rendering works without a FAL_KEY.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Image as ImageIcon, Loader2, Sparkles, Search, Upload, Copy, Trash2, AlertTriangle, Wand2, Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { SIZE_PRESETS, type AssetRole } from "@/lib/media/plan";
import { PageHeader } from "@/components/layout/PageHeader";
import { SegmentedControl } from "@/components/ui/segmented-control";

interface Asset {
  id: string; url: string; width: number | null; height: number | null;
  role: string; alt: string | null; prompt: string | null; model: string | null;
  source: string; created_at: string;
}

const ROLES: Array<{ key: AssetRole; label: string; blurb: string }> = [
  { key: "hero", label: "Article hero", blurb: "Wide opening image. Priority-loaded, so it is the LCP element." },
  { key: "inline", label: "Body image", blurb: "Breaks up a section. Lazy-loaded, never carries text." },
  { key: "og", label: "Social card", blurb: "The thumbnail in a feed. The only asset where text belongs." },
  { key: "thumbnail", label: "Strapi thumbnail", blurb: "Required before Strapi will publish. Same spec as the social card." },
];

export default function MediaPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [stats, setStats] = useState<{ assets: number; generations: number; failures: number } | null>(null);
  const [genEnabled, setGenEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("");

  // The generate form.
  const [role, setRole] = useState<AssetRole>("hero");
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("");
  const [direction, setDirection] = useState("");
  /** Where the image will be used. Optional in spirit — it defaults to blog — but exposed as a real
   *  choice because it changes the art direction more than any other input, so it is the one thing
   *  worth asking before a two-word prompt. */
  const [surface, setSurface] = useState<"blog" | "landing">("blog");
  const [count, setCount] = useState(2);
  const [busy, setBusy] = useState(false);
  /** How many tiles are rendering right now. Drives the placeholder cards: you asked for N variants,
   *  so N slots appear immediately and the gallery stops looking empty while the model works. */
  const [pending, setPending] = useState(0);
  /** The asset opened at true size. Square tiles crop, so there has to be a way back to the real image. */
  const [preview, setPreview] = useState<Asset | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      if (roleFilter) p.set("role", roleFilter);
      const d = await fetch(`/api/media?${p}`).then((r) => r.json());
      if (!d?.ok) { toast.error(d?.error ?? "Couldn't load the gallery."); return; }
      setAssets(d.assets); setStats(d.stats); setGenEnabled(d.generation_enabled);
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't load the gallery.");
    } finally { setLoading(false); }
  }, [q, roleFilter]);

  useEffect(() => { void load(); }, [load]);

  // Escape closes the full-size preview. Bound only while one is open so it cannot swallow Escape
  // from anything else on the page.
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPreview(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview]);

  async function generate() {
    if (!subject.trim()) { toast.error("Describe what the image should show."); return; }
    setBusy(true);
    setPending(count);
    try {
      const d = await fetch("/api/media/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, surface, subject: subject.trim(), topic: topic.trim() || subject.trim(), direction: direction.trim(), count }),
      }).then((r) => r.json());

      if (!d?.ok) { toast.error(d?.error ?? "Generation failed."); return; }
      const made = (d.assets ?? []).length;
      // A refusal is the model declining the prompt, not a fault on our side — say which it was.
      const refused = (d.results ?? []).filter((r: any) => r.refused);
      const failed = (d.results ?? []).filter((r: any) => !r.ok && !r.refused);
      if (made) toast.success(`${made} image${made === 1 ? "" : "s"} generated.`);
      for (const r of refused) toast.warning(`The model declined that prompt: ${r.error}`);
      for (const r of failed) toast.error(r.error);
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? "Generation failed.");
    } finally { setBusy(false); setPending(0); }
  }

  /** An upload goes through the existing Strapi upload route, then gets registered in the gallery so
   *  it is available from the same picker as everything generated. */
  async function upload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("alt", file.name.replace(/\.[a-z0-9]+$/i, ""));
      const up = await fetch("/api/blog/upload", { method: "POST", body: fd }).then((r) => r.json());
      if (!up?.ok) { toast.error(up?.error ?? "Upload failed."); return; }
      const reg = await fetch("/api/media", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: up.url, source: "uploaded", role,
          alt: file.name.replace(/\.[a-z0-9]+$/i, ""),
          strapi_media_id: up.media?.[0]?.id ?? null, mime: file.type,
        }),
      }).then((r) => r.json());
      if (!reg?.ok) { toast.error(reg?.error ?? "Uploaded, but couldn't add it to the gallery."); return; }
      toast.success("Uploaded and added to the gallery.");
      await load();
    } catch (e: any) {
      toast.error(e?.message ?? "Upload failed.");
    } finally { setUploading(false); }
  }

  async function archive(id: string) {
    const d = await fetch(`/api/media/${id}`, { method: "DELETE" }).then((r) => r.json()).catch(() => null);
    if (!d?.ok) { toast.error(d?.error ?? "Couldn't remove it."); return; }
    setAssets((a) => a.filter((x) => x.id !== id));
    toast.success("Removed from the gallery.");
  }

  const preset = SIZE_PRESETS[role];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader icon={ImageIcon} title="Assets" description="Art for blogs and landing pages. Everything lands in the gallery and is available wherever the platform asks for an image." />
      <div className="flex min-h-0 flex-1 gap-6">
      {/* Generate */}
      <div className="w-80 shrink-0 h-full min-h-0 flex flex-col overflow-hidden rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-[64px] backdrop-saturate-[1.65] shadow-[var(--glass-shadow)]">
        <div className="p-4 border-b border-border">
          <p className="text-sm font-medium">Generate an image</p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {!genEnabled && (
            <div className="rounded-lg border border-warning/40 bg-warning/5 p-3 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
              <p className="text-xs leading-relaxed">
                <span className="font-medium">FAL_KEY is not set</span>, so nothing can be rendered yet.
                Uploading, browsing and picking all work — add the key and generation lights up.
              </p>
            </div>
          )}

          {/* Surface first, because it changes the art direction more than anything else on this form.
              A blog image should look commissioned and stay out of the reader's way; a landing image IS
              the pitch. Same subject, opposite treatment — so this is asked before the prompt, and it
              is why two words of subject is now enough input. */}
          <div className="space-y-1.5">
            <Label>Where will it be used</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {([
                { key: "blog" as const, label: "Blog post", blurb: "Editorial, restrained, sits beside prose" },
                { key: "landing" as const, label: "Landing page", blurb: "Premium, high contrast, room for a headline" },
              ]).map((s) => (
                <button key={s.key} type="button" onClick={() => setSurface(s.key)}
                  className={cn("text-left rounded-lg border px-2.5 py-2 transition-colors",
                    surface === s.key
                      ? "border-highlight/60 bg-highlight-soft"
                      : "border-border hover:bg-muted/40")}>
                  <p className="text-xs font-medium">{s.label}</p>
                  <p className="text-xs text-muted-foreground leading-snug">{s.blurb}</p>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>What is it for</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {ROLES.map((r) => (
                <button key={r.key} type="button" onClick={() => setRole(r.key)}
                  className={cn("text-left rounded-lg border px-2.5 py-2 transition-colors",
                    role === r.key
                      ? "border-highlight/60 bg-highlight-soft"
                      : "border-border hover:bg-muted/40")}>
                  <p className="text-xs font-medium">{r.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {SIZE_PRESETS[r.key].width}×{SIZE_PRESETS[r.key].height}
                  </p>
                </button>
              ))}
            </div>
            {/* The size is a ranking decision, so the reason is on screen rather than in a doc. */}
            <p className="text-xs text-muted-foreground leading-relaxed flex gap-1.5 pt-0.5">
              <Info className="h-3.5 w-3.5 shrink-0 mt-px text-highlight-ink/70" />
              <span>{preset.why}</span>
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="subject">What should it show</Label>
            <p className="text-xs text-muted-foreground">Just the subject — the look is handled by the choice above.</p>
            <Textarea id="subject" value={subject} onChange={(e) => setSubject(e.target.value)}
              className="min-h-[72px] text-sm"
              placeholder="A fashion model photographed in a studio, garments crisp and evenly lit" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="topic">Article topic <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input id="topic" value={topic} onChange={(e) => setTopic(e.target.value)}
              placeholder="ai fashion model generator" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="direction">Extra direction <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input id="direction" value={direction} onChange={(e) => setDirection(e.target.value)}
              placeholder="cooler palette, more negative space" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="count">Variants</Label>
            <div className="flex items-center gap-2">
              <Input id="count" type="number" min={1} max={4} value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
                className="w-20" />
              <p className="text-xs text-muted-foreground leading-snug">
                Each variant is locked to a different look, so they actually differ.
              </p>
            </div>
          </div>

          <Button className="w-full gap-1.5" disabled={busy || !subject.trim()} onClick={generate}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {busy ? "Rendering — this takes a minute" : "Generate"}
          </Button>

          <div className="pt-1">
            <input ref={uploadRef} type="file" accept="image/*" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
            <Button variant="outline" className="w-full gap-1.5" disabled={uploading}
              onClick={() => uploadRef.current?.click()}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Upload from your computer
            </Button>
          </div>

          {stats && (
            <p className="text-xs text-muted-foreground pt-1">
              {stats.assets} in the gallery · {stats.generations} generation
              {stats.generations === 1 ? "" : "s"} run
              {stats.failures > 0 ? ` · ${stats.failures} refused or failed` : ""}
            </p>
          )}
        </div>
      </div>

      {/* Gallery */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 pb-3 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-9"
              placeholder="Search by prompt or alt text…" />
          </div>
          <SegmentedControl
            aria-label="Image role"
            value={roleFilter}
            onChange={setRoleFilter}
            options={[{ value: "", label: "All" }, ...ROLES.map((r) => ({ value: r.key as string, label: r.label }))]}
          />
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="h-40 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : assets.length === 0 && pending === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center gap-2 text-muted-foreground">
              <Wand2 className="h-7 w-7 opacity-40" />
              <p className="text-sm">Nothing here yet.</p>
              <p className="text-xs max-w-sm">
                Generate something on the left, or upload an image. Everything you add becomes available
                from the image picker in the blog editor.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 pb-6">
              {/* Tiles in flight, one per requested variant. They sit at the front so the work appears
                  exactly where the result will land, rather than only as a spinner on a button
                  somewhere else on the page. */}
              {Array.from({ length: pending }, (_, i) => (
                <div key={`pending-${i}`} className="rounded-lg border border-border overflow-hidden flex flex-col">
                  <div className="gen-dots relative aspect-square grid place-items-center">
                    <span className="relative z-10 flex items-center gap-2 rounded-full border border-[var(--glass-border)] bg-[var(--glass-bar)] px-3 py-1.5 text-xs backdrop-blur-[20px]">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating
                    </span>
                  </div>
                  <div className="p-2.5">
                    <p className="text-xs text-muted-foreground">
                      Variant {i + 1} of {pending} · about a minute
                    </p>
                  </div>
                </div>
              ))}
              {assets.map((a) => (
                <div key={a.id} className="group rounded-lg border border-border overflow-hidden bg-muted/20 flex flex-col">
                  {/* Square, because a grid of mixed aspect ratios reads as broken rather than varied.
                      Cropping is the trade, so the tile is a button that opens the real thing. */}
                  <button type="button" onClick={() => setPreview(a)}
                    className="relative aspect-square bg-muted/40 w-full cursor-zoom-in"
                    aria-label={`Open ${a.alt || a.role} at full size`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.url} alt={a.alt ?? ""} loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
                  </button>
                  <div className="p-2.5 space-y-1.5 flex-1 flex flex-col">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <Badge variant="outline" className="text-xs">{a.role}</Badge>
                      {a.width && a.height && (
                        <span className="text-xs text-muted-foreground">{a.width}×{a.height}</span>
                      )}
                      {a.source !== "generated" && (
                        <Badge variant="outline" className="text-xs text-muted-foreground">{a.source}</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 flex-1">
                      {a.alt || a.prompt || "No description"}
                    </p>
                    <div className="flex items-center gap-1 pt-0.5">
                      <Button size="xs" variant="outline" className="gap-1 flex-1"
                        onClick={() => { void navigator.clipboard.writeText(a.url); toast.success("URL copied."); }}>
                        <Copy className="h-3 w-3" /> Copy URL
                      </Button>
                      <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive"
                        onClick={() => archive(a.id)} aria-label="Remove from gallery">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* True-size preview. `max-w/h-none` on the image so it renders at its NATURAL pixel size — the
          point is to check the actual asset, and a fitted image would just be a bigger crop. The
          wrapper scrolls when the image is larger than the viewport, which for a 1600x900 hero on a
          laptop it usually is. Backdrop click and Escape both close, because a full-bleed overlay with
          only a small × is a trap. */}
      {preview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={preview.alt || `${preview.role} image`}
          className="fixed inset-0 z-[120] flex flex-col bg-black/80 backdrop-blur-[6px]"
          onClick={() => setPreview(null)}
        >
          <div className="flex shrink-0 items-center gap-3 px-5 py-3 text-sm text-white/80">
            <span className="rounded-full border border-white/20 px-2.5 py-1 text-xs">{preview.role}</span>
            {preview.width && preview.height && (
              <span className="tabular-nums">{preview.width}×{preview.height}</span>
            )}
            <span className="min-w-0 flex-1 truncate">{preview.alt || preview.prompt || ""}</span>
            <button type="button" onClick={() => setPreview(null)}
              className="grid size-9 shrink-0 place-items-center rounded-full border border-white/20 transition-colors hover:bg-white/10"
              aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          {/* Large enough to judge, deliberately not edge-to-edge. `max-h-full` let the image grow into
              whatever space was left, which on a tall window is almost the entire screen — bigger than
              anyone needs and it loses the sense of the image as an object. Capped at 72vh/80vw so a
              portrait asset and a 16:9 hero both sit comfortably with breathing room around them. Real
              pixel dimensions are in the header for when the number is what you actually want. */}
          <div className="grid min-h-0 flex-1 place-items-center p-6" onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview.url} alt={preview.alt ?? ""}
              className="max-h-[72vh] max-w-[80vw] rounded-lg object-contain shadow-2xl" />
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
