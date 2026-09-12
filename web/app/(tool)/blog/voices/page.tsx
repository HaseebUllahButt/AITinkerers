"use client";

// Voice profiles: the brand styles the AI writer can be pointed at.
//
// The reason this is a page rather than a config file: the SEO team owns tone of voice, they have
// more than one (the Northwind house voice plus the Misher F&B persona), and they need to change a
// banned word or add an internal link without waiting for a deploy.
//
// The "What the model actually sees" panel is the important part of this screen. Everything else is
// a form; that panel is the only place you can check that an edit produced the instruction you
// intended, rather than inferring it from the fields.
import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import {
  Mic2, Plus, Loader2, Save, Star, Eye, EyeOff, Archive, RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { WriterVoice } from "@/lib/db/queries";
import { PageHeader } from "@/components/layout/PageHeader";

/** Textareas edit these as one-per-line text; the API accepts either that or a real array. */
function toLines(v: unknown): string {
  return Array.isArray(v) ? v.join("\n") : String(v ?? "");
}
function sitemapToText(v: unknown): string {
  let arr: any = v;
  if (typeof v === "string") { try { arr = JSON.parse(v); } catch { return ""; } }
  if (!Array.isArray(arr)) return "";
  // "url | category | description" is editable by hand and survives a copy-paste from a sheet.
  return arr.map((l: any) =>
    [l?.url ?? "", l?.category ?? "", l?.description ?? ""].join(" | ")).join("\n");
}
function textToSitemap(text: string) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [url, category, ...rest] = line.split("|").map((s) => s.trim());
    return { url, category: category || null, description: rest.join(" | ").trim() || null };
  }).filter((l) => l.url);
}

export default function VoicesPage() {
  const [voices, setVoices] = useState<WriterVoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [rendered, setRendered] = useState("");
  const [approxTokens, setApproxTokens] = useState(0);
  const [showRendered, setShowRendered] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fetch("/api/blog/voices?archived=1").then((r) => r.json());
      if (d?.ok) {
        setVoices(d.voices);
        setSelectedId((prev) => prev ?? d.voices.find((v: WriterVoice) => v.is_default)?.id ?? d.voices[0]?.id ?? null);
      } else toast.error(d?.error ?? "Couldn't load voices.");
    } catch (e: any) { toast.error(e?.message ?? "Couldn't load voices."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Load the selected voice into the form, along with the prompt it currently renders to.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetch(`/api/blog/voices/${selectedId}`).then((r) => r.json()).then((d) => {
      if (cancelled || !d?.ok) return;
      const v: WriterVoice = d.voice;
      setForm({
        name: v.name, description: v.description ?? "", brand_name: v.brand_name ?? "",
        tone_doc: v.tone_doc, workflow_rules: v.workflow_rules,
        banned_words: toLines(v.banned_words), banned_phrases: toLines(v.banned_phrases),
        sitemap_links: sitemapToText(v.sitemap_links),
        default_word_count: v.default_word_count,
        default_cta_text: v.default_cta_text ?? "", default_cta_url: v.default_cta_url ?? "",
        allowed_link_hosts: toLines(v.allowed_link_hosts),
      });
      setRendered(d.rendered); setApproxTokens(d.approx_tokens); setDirty(false);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selectedId]);

  const selected = voices.find((v) => v.id === selectedId) ?? null;
  const set = (k: string, val: any) => { setForm((f) => ({ ...f, [k]: val })); setDirty(true); };

  async function save() {
    if (!selectedId) return;
    setSaving(true);
    try {
      const d = await fetch(`/api/blog/voices/${selectedId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          banned_words: String(form.banned_words ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
          banned_phrases: String(form.banned_phrases ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
          allowed_link_hosts: String(form.allowed_link_hosts ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
          sitemap_links: textToSitemap(String(form.sitemap_links ?? "")),
        }),
      }).then((r) => r.json());
      if (!d?.ok) { toast.error(d?.error ?? "Save failed."); return; }
      setRendered(d.rendered); setApproxTokens(d.approx_tokens); setDirty(false);
      setVoices((vs) => vs.map((v) => (v.id === d.voice.id ? d.voice : v)));
      // Worth telling them: a prompt-bearing change costs one cold cache write on the next run,
      // whereas a rename is free. Otherwise that cost is completely invisible.
      toast.success(d.prompt_changed
        ? `Saved. The prompt changed, so the next article pays one cache write (now revision ${d.voice.prompt_revision}).`
        : "Saved. The prompt is unchanged, so the cache stays warm.");
    } catch (e: any) { toast.error(e?.message ?? "Save failed."); }
    finally { setSaving(false); }
  }

  async function makeDefault() {
    if (!selectedId) return;
    const d = await fetch(`/api/blog/voices/${selectedId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "make_default" }),
    }).then((r) => r.json()).catch(() => null);
    if (d?.ok) { toast.success(`"${d.voice.name}" is now the default voice.`); load(); }
    else toast.error(d?.error ?? "Couldn't change the default.");
  }

  async function toggleArchived() {
    if (!selected) return;
    const next = !selected.archived;
    const d = await fetch(`/api/blog/voices/${selected.id}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: next }),
    }).then((r) => r.json()).catch(() => null);
    if (d?.ok) { toast.success(next ? "Voice archived." : "Voice restored."); load(); }
    else toast.error(d?.error ?? "Couldn't update.");
  }

  async function newVoice() {
    const name = window.prompt("Name this voice (e.g. \"Technical docs\"):")?.trim();
    if (!name) return;
    const d = await fetch("/api/blog/voices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => r.json()).catch(() => null);
    if (d?.ok) { await load(); setSelectedId(d.voice.id); toast.success(`Created "${name}". Add its tone of voice below.`); }
    else toast.error(d?.error ?? "Couldn't create the voice.");
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <PageHeader icon={Mic2} title="Voices" description="How the AI writer sounds. Pick one per article." />
      <div className="flex min-h-0 flex-1 gap-6">
      {/* List */}
      <div className="w-64 shrink-0 border border-border rounded-lg flex flex-col overflow-hidden">
        <div className="p-3 border-b border-border space-y-2">
          <Button size="sm" className="w-full gap-1.5" onClick={newVoice}>
            <Plus className="h-3.5 w-3.5" /> New voice
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-4 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto text-muted-foreground" /></div>
          ) : voices.map((v) => (
            <button key={v.id} onClick={() => setSelectedId(v.id)}
              className={cn("w-full text-left px-3 py-2.5 border-b border-border/60 hover:bg-muted/40",
                selectedId === v.id && "bg-highlight-soft", v.archived && "opacity-50")}>
              <p className="flex items-center gap-1.5 min-w-0">
                {v.is_default && <Star className="h-3 w-3 text-highlight-ink shrink-0" fill="currentColor" />}
                <span className="text-sm font-medium truncate">{v.name}</span>
              </p>
              <p className="text-xs text-muted-foreground truncate mt-0.5 font-mono">{v.slug}</p>
              {v.archived && <p className="text-xs text-muted-foreground mt-0.5">archived</p>}
            </button>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div className="flex-1 overflow-y-auto pr-1">
        {!selected ? (
          <div className="h-full flex items-center justify-center text-sm text-muted-foreground">
            Pick a voice on the left.
          </div>
        ) : (
          <div className="max-w-3xl space-y-4">
            <div className="sticky top-0 z-10 mb-2 flex items-center gap-2 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-bar)] backdrop-blur-[24px] px-3 py-2">
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-semibold truncate">{selected.name}</h2>
                <p className="text-xs text-muted-foreground">
                  prompt revision {selected.prompt_revision}
                  {dirty && <span className="text-warning"> · unsaved changes</span>}
                </p>
              </div>
              {selected.is_default
                ? <Badge variant="outline" className="text-highlight-ink border-highlight/40 text-xs">default</Badge>
                : !selected.archived && (
                  <Button size="xs" variant="ghost" className="gap-1 text-xs" onClick={makeDefault}>
                    <Star className="h-3 w-3" /> Make default
                  </Button>
                )}
              <Button size="xs" variant="ghost" className="gap-1 text-xs" onClick={toggleArchived}
                disabled={selected.is_default}
                title={selected.is_default ? "The default voice can't be archived." : undefined}>
                {selected.archived ? <><RotateCcw className="h-3 w-3" /> Restore</> : <><Archive className="h-3 w-3" /> Archive</>}
              </Button>
              <Button size="sm" className="gap-1.5" onClick={save} disabled={saving || !dirty}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} Save
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="v-name">Name</Label>
                <Input id="v-name" value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="v-brand">Brand name</Label>
                <Input id="v-brand" value={form.brand_name ?? ""} onChange={(e) => set("brand_name", e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="v-desc">When to use this voice</Label>
              <Input id="v-desc" value={form.description ?? ""} onChange={(e) => set("description", e.target.value)}
                placeholder="Shown in the picker, so whoever writes next knows which to choose." />
            </div>

            <div className="space-y-1">
              <Label htmlFor="v-tone">Tone of voice</Label>
              <p className="text-xs text-muted-foreground">
                The main instruction. Be concrete and give examples: &quot;short sentences&quot; is weaker than
                showing a sentence you want and one you don&apos;t.
              </p>
              <Textarea id="v-tone" value={form.tone_doc ?? ""} onChange={(e) => set("tone_doc", e.target.value)}
                className="min-h-[300px] font-mono text-xs" />
            </div>

            <div className="space-y-1">
              <Label htmlFor="v-rules">Extra workflow rules (optional)</Label>
              <p className="text-xs text-muted-foreground">
                Structural habits specific to this voice, e.g. &quot;open every section with a lived anecdote&quot;.
              </p>
              <Textarea id="v-rules" value={form.workflow_rules ?? ""} onChange={(e) => set("workflow_rules", e.target.value)}
                className="min-h-[90px] font-mono text-xs" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="v-words">Banned words (one per line)</Label>
                <p className="text-xs text-muted-foreground">Checked automatically. A match sends the section back to be rewritten.</p>
                <Textarea id="v-words" value={form.banned_words ?? ""} onChange={(e) => set("banned_words", e.target.value)}
                  className="min-h-[160px] font-mono text-xs" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="v-phrases">Banned phrases (one per line)</Label>
                <p className="text-xs text-muted-foreground">Multi-word, e.g. &quot;in today&apos;s fast-paced world&quot;.</p>
                <Textarea id="v-phrases" value={form.banned_phrases ?? ""} onChange={(e) => set("banned_phrases", e.target.value)}
                  className="min-h-[160px] font-mono text-xs" />
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="v-sitemap">Internal links the writer may use</Label>
              <p className="text-xs text-muted-foreground">
                One per line: <code className="text-xs">url | category | description</code>. The writer can
                only link to URLs on this list. Anything else counts as invented and fails the piece.
              </p>
              <Textarea id="v-sitemap" value={form.sitemap_links ?? ""} onChange={(e) => set("sitemap_links", e.target.value)}
                className="min-h-[180px] font-mono text-xs" />
            </div>

            <div className="rounded-lg border border-border p-3 space-y-3">
              <p className="text-xs font-medium">Defaults for this voice</p>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="v-wc">Word count</Label>
                  <Input id="v-wc" type="number" value={form.default_word_count ?? 2500}
                    onChange={(e) => set("default_word_count", e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="v-cta">CTA text</Label>
                  <Input id="v-cta" value={form.default_cta_text ?? ""} onChange={(e) => set("default_cta_text", e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="v-ctaurl">CTA URL</Label>
                  <Input id="v-ctaurl" value={form.default_cta_url ?? ""} onChange={(e) => set("default_cta_url", e.target.value)}
                    className="font-mono text-xs" />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="v-hosts">Our own domains (one per line)</Label>
                <p className="text-xs text-muted-foreground">
                  A CTA or internal link outside these hosts is rejected, so the writer can&apos;t invent a link target.
                </p>
                <Textarea id="v-hosts" value={form.allowed_link_hosts ?? ""} onChange={(e) => set("allowed_link_hosts", e.target.value)}
                  className="min-h-[70px] font-mono text-xs" />
              </div>
            </div>

            {/* The only place you can confirm an edit produced the instruction you meant. */}
            <div className="rounded-lg border border-border">
              <button onClick={() => setShowRendered((s) => !s)}
                className="w-full flex items-center gap-2 p-3 text-xs font-medium hover:bg-muted/40">
                {showRendered ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                What the model actually sees
                <span className="text-xs text-muted-foreground font-normal ml-auto">
                  ≈{approxTokens.toLocaleString()} tokens{dirty && " · save to refresh"}
                </span>
              </button>
              {showRendered && (
                <pre className="p-3 border-t border-border text-xs font-mono whitespace-pre-wrap overflow-x-auto max-h-[420px] overflow-y-auto text-muted-foreground">
                  {rendered}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
