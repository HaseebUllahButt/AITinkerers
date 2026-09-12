"use client";

// The gallery, as a picker.
//
// Every place this app asks for an image offers the same FOUR routes in: pick something already made,
// generate a new one, upload from the computer, or paste a URL. The gallery being one of them is the
// whole point of having a gallery — an asset generated for one post is usually the right asset for the
// next one, and without this it would be write-only.
//
// Generation lives here rather than beside each slot because this component IS the one surface every
// slot opens. One integration, and no slot can be forgotten when a new one is added later.
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Search, ImageIcon, Upload, Link2, Sparkles } from "lucide-react";
import { ImageGenerator, type GenRole } from "./ImageGenerator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Asset {
  id: string; url: string; width: number | null; height: number | null;
  role: string; alt: string | null; prompt: string | null;
}

export function GalleryPicker({
  open, onClose, onPick, role, uploading, onUpload, subject, draftId,
}: {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen image. `alt` comes along because a placed image needs one. */
  onPick: (asset: { url: string; alt: string; width?: number | null; height?: number | null }) => void;
  /** Filters the initial view, but the user can always see everything. */
  role?: string;
  uploading?: boolean;
  onUpload?: (file: File) => void;
  /** The draft's title, so the generator's prompt is never empty on a page that knows its subject. */
  subject?: string;
  /** Attaches a generated asset to the draft, the way the pipeline does. */
  draftId?: string | null;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [onlyRole, setOnlyRole] = useState(!!role);
  const [urlValue, setUrlValue] = useState("");
  const [mode, setMode] = useState<"library" | "generate">("library");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ limit: "60" });
      if (q.trim()) p.set("q", q.trim());
      if (onlyRole && role) p.set("role", role);
      const d = await fetch(`/api/media?${p}`).then((r) => r.json());
      if (d?.ok) setAssets(d.assets);
    } catch { /* the picker still offers upload and URL */ }
    finally { setLoading(false); }
  }, [q, onlyRole, role]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
      onClick={onClose}>
      <div className="w-[60vw] min-w-[560px] max-w-[95vw] h-[60vh] min-h-[420px] rounded-2xl border border-[var(--glass-border)] bg-[var(--popover)] backdrop-blur-[20px] shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}>
        <div className="p-4 border-b border-border space-y-3">
          <div className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-highlight-ink" />
            <h2 className="text-sm font-semibold">Add an image</h2>
            <div className="ml-3 flex items-center gap-1">
              {(["library", "generate"] as const).map((m) => (
                <button key={m} type="button" onClick={() => setMode(m)}
                  className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs capitalize transition-colors",
                    mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}>
                  {m === "generate" && <Sparkles className="h-3.5 w-3.5" />}
                  {m}
                </button>
              ))}
            </div>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={onClose}>Close</Button>
          </div>

          {mode === "library" && (
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} className="pl-9"
                placeholder="Search the gallery…" />
            </div>
            {role && (
              <Button size="sm" variant={onlyRole ? "default" : "outline"}
                onClick={() => setOnlyRole((v) => !v)}>
                {onlyRole ? `Only ${role}` : "All roles"}
              </Button>
            )}
            {onUpload && (
              <>
                <input id="gallery-upload" type="file" accept="image/*" hidden
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; }} />
                <Button size="sm" variant="outline" className="gap-1.5" disabled={uploading}
                  onClick={() => document.getElementById("gallery-upload")?.click()}>
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Upload
                </Button>
              </>
            )}
          </div>

          )}

          {mode === "library" && (
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />
            <Input value={urlValue} onChange={(e) => setUrlValue(e.target.value)}
              placeholder="…or paste an image URL" className="flex-1" />
            <Button size="sm" variant="outline" disabled={!/^https?:\/\//i.test(urlValue.trim())}
              onClick={() => {
                onPick({ url: urlValue.trim(), alt: "" });
                setUrlValue("");
                onClose();
              }}>
              Use it
            </Button>
          </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {mode === "generate" ? (
            <ImageGenerator
              role={(role === "thumbnail" ? "thumbnail" : role === "inline" ? "inline" : "hero") as GenRole}
              defaultSubject={subject}
              draftId={draftId}
              onPick={(img) => { onPick(img); onClose(); }}
            />
          ) : loading ? (
            <div className="h-32 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : assets.length === 0 ? (
            <div className="h-32 flex flex-col items-center justify-center gap-1.5 text-center text-muted-foreground">
              <p className="text-sm">The gallery is empty.</p>
              <p className="text-xs">
                Generate assets on the Assets page, or upload one above.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {assets.map((a) => (
                <button key={a.id} type="button"
                  onClick={() => {
                    // An image without alt text is an accessibility and SEO failure, so if the asset
                    // has none we still place it but say so rather than silently shipping empty alt.
                    if (!a.alt?.trim()) toast.warning("That asset has no alt text — add one in the editor.");
                    onPick({ url: a.url, alt: a.alt ?? "", width: a.width, height: a.height });
                    onClose();
                  }}
                  className={cn("group text-left rounded-lg border border-border overflow-hidden",
                    "hover:border-highlight/60 focus-visible:border-highlight focus-visible:outline-none transition-colors")}>
                  <div className="relative aspect-[16/10] bg-muted/40">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.url} alt={a.alt ?? ""} loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover" />
                  </div>
                  <div className="p-2">
                    <p className="text-xs truncate">{a.alt || a.prompt || a.role}</p>
                    {a.width && a.height && (
                      <p className="text-xs text-muted-foreground">{a.width}×{a.height}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
