"use client";

import { useEffect, useState } from "react";
import { Megaphone, Plus, X, Loader2, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { LoadFailed, fetchHonest } from "@/components/ui/load-failed";
import type { Campaign } from "@/lib/types";
import { PageHeader } from "@/components/layout/PageHeader";

function StatusBadge({ status }: { status: Campaign["status"] }) {
  if (status === "done") return <Badge className="bg-success/15 text-success border-success/40 hover:bg-success/15">Done</Badge>;
  if (status === "running") return <Badge className="bg-warning/15 text-warning border-warning/30 hover:bg-warning/15"><Loader2 className="h-3 w-3 animate-spin mr-1" />Running</Badge>;
  return <Badge variant="outline" className="text-muted-foreground">Draft</Badge>;
}

export default function CampaignsPage() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  /** A failed load must never render as "No campaigns yet" — the error is state, not silence. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null); // null = creating new
  const [form, setForm] = useState({ name: "", keywordInput: "", keywords: [] as string[], seedWriterName: "", seedArticleUrl: "", seedDomains: "", seedArticleUrls: "" });
  const [saving, setSaving] = useState(false);

  function openNew() {
    setEditingId(null);
    setForm({ name: "", keywordInput: "", keywords: [], seedWriterName: "", seedArticleUrl: "", seedDomains: "", seedArticleUrls: "" });
    setCreating(true);
  }
  function openEdit(c: Campaign) {
    setEditingId(c.id);
    setForm({ name: c.name, keywordInput: "", keywords: c.keywords ?? [], seedWriterName: c.seed_writer_name ?? "", seedArticleUrl: c.seed_article_url ?? "", seedDomains: (c.seed_domains ?? []).join("\n"), seedArticleUrls: (c.seed_article_urls ?? []).join("\n") });
    setCreating(true);
  }
  const parseList = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

  async function fetchCampaigns() {
    setLoading(true);
    const { data, reason } = await fetchHonest<Campaign[]>("/api/campaigns");
    if (data) { setCampaigns(data); setLoadError(null); }
    else setLoadError(reason); // keep whatever campaigns are already shown
    setLoading(false);
  }

  useEffect(() => { fetchCampaigns(); }, []);

  function addKeyword() {
    const kw = form.keywordInput.trim().toLowerCase();
    if (!kw || form.keywords.includes(kw)) { setForm(f => ({ ...f, keywordInput: "" })); return; }
    setForm(f => ({ ...f, keywords: [...f.keywords, kw], keywordInput: "" }));
  }

  function removeKeyword(kw: string) {
    setForm(f => ({ ...f, keywords: f.keywords.filter(k => k !== kw) }));
  }

  async function handleCreateOrSave() {
    const domains = parseList(form.seedDomains);
    const articleUrls = parseList(form.seedArticleUrls);
    if (!form.name || (!form.keywords.length && !form.seedWriterName.trim() && !form.seedArticleUrl.trim() && !domains.length && !articleUrls.length)) return;
    setSaving(true);
    const payload = {
      name: form.name,
      keywords: form.keywords,
      seed_writer_name: form.seedWriterName.trim() || null,
      seed_article_url: form.seedArticleUrl.trim() || null,
      seed_domains: domains,
      seed_article_urls: articleUrls,
    };
    const res = editingId
      ? await fetch(`/api/campaigns/${editingId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      : await fetch("/api/campaigns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (res.ok) {
      setCreating(false);
      setEditingId(null);
      setForm({ name: "", keywordInput: "", keywords: [], seedWriterName: "", seedArticleUrl: "", seedDomains: "", seedArticleUrls: "" });
      fetchCampaigns();
    }
    setSaving(false);
  }

  return (
    <div>
      {/* Header */}
      <PageHeader
        icon={Megaphone}
        title="Campaigns"
        description="Keyword sets for discovery. Pick one from the campaign menu on Prospects."
        className="mb-6"
        actions={
          <Button onClick={openNew} size="sm">
            <Plus className="h-4 w-4 mr-1.5" />
            New Campaign
          </Button>
        }
      />

      {loadError && (
        <LoadFailed nothing="your campaigns" detail={loadError} onRetry={() => void fetchCampaigns()} className="mb-4" />
      )}

      {/* Campaign grid */}
      {loading ? (
        <div className="flex items-center justify-center h-48 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" />Loading campaigns...
        </div>
      ) : campaigns.length === 0 && !loadError ? (
        <div className="border border-dashed border-border rounded-xl flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
          <Megaphone className="h-8 w-8 opacity-30" />
          <p className="text-sm">No campaigns yet — create one, then select it when running discovery</p>
          <Button variant="outline" size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mr-1.5" />Create Campaign
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {campaigns.map((c) => (
            <div key={c.id} className="border border-border rounded-xl p-5 bg-card flex flex-col gap-4 hover:border-highlight/40 transition-colors">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-sm truncate">{c.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {new Date(c.created_at).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <StatusBadge status={c.status} />
                  <Button variant="ghost" size="sm" className="h-10 px-2 text-xs" onClick={() => openEdit(c)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {/* Keywords + seed writer */}
              <div className="flex flex-wrap gap-1.5">
                {c.keywords.map((kw) => (
                  <span key={kw} className="text-xs bg-highlight-soft text-highlight-ink border border-highlight/40 px-2 py-0.5 rounded-full">
                    {kw}
                  </span>
                ))}
                {c.seed_writer_name && (
                  <span className="text-xs bg-highlight-soft text-highlight-ink border border-highlight/20 px-2 py-0.5 rounded-full">
                    ✍ {c.seed_writer_name}
                  </span>
                )}
                {(c.seed_domains?.length ?? 0) > 0 && (
                  <span className="text-xs bg-success/15 text-success border border-success/20 px-2 py-0.5 rounded-full">
                    🌐 {c.seed_domains!.length} site{c.seed_domains!.length === 1 ? "" : "s"}
                  </span>
                )}
                {(c.seed_article_urls?.length ?? 0) > 0 && (
                  <span className="text-xs bg-warning/10 text-warning border border-warning/20 px-2 py-0.5 rounded-full">
                    📄 {c.seed_article_urls!.length} article{c.seed_article_urls!.length === 1 ? "" : "s"}
                  </span>
                )}
                {c.keywords.length === 0 && !c.seed_writer_name && !c.seed_article_url && !(c.seed_domains?.length) && !(c.seed_article_urls?.length) && (
                  <span className="text-xs text-muted-foreground italic">No keywords — uses global seeds</span>
                )}
              </div>

              {/* Stats */}
              <div className="flex items-center gap-4 text-xs text-muted-foreground mt-auto">
                <span><span className="font-semibold text-foreground">{c.author_count ?? 0}</span> authors</span>
                <span><span className="font-semibold text-foreground">{c.target_hits.toLocaleString()}</span> target hits</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Campaign Dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Campaign" : "New Campaign"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Campaign name</Label>
              <Input
                placeholder="e.g. Image Generation Q3"
                value={form.name}
                onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Keywords</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="e.g. image generation"
                  value={form.keywordInput}
                  onChange={(e) => setForm(f => ({ ...f, keywordInput: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addKeyword(); } }}
                />
                <Button type="button" variant="outline" onClick={addKeyword} disabled={!form.keywordInput.trim()}>
                  Add
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Press Enter or click Add. {editingId ? "Editing keywords takes effect the next time you run discovery for this campaign — the new keywords are searched with priority." : "These focus what writers get discovered when you select this campaign in the discovery dropdown, and are searched with priority."}
              </p>
              {form.keywords.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {form.keywords.map((kw) => (
                    <span key={kw} className="flex items-center gap-1 text-xs bg-highlight-soft text-highlight-ink border border-highlight/40 px-2 py-0.5 rounded-full">
                      {kw}
                      <button onClick={() => removeKeyword(kw)} className="hover:text-destructive transition-colors">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2 border-t border-border pt-4">
              <Label>Seed a specific writer <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                placeholder="Writer's name, e.g. Jane Doe"
                value={form.seedWriterName}
                onChange={(e) => setForm(f => ({ ...f, seedWriterName: e.target.value }))}
              />
              <Input
                placeholder="One article link by them (optional but helps us find them faster)"
                value={form.seedArticleUrl}
                onChange={(e) => setForm(f => ({ ...f, seedArticleUrl: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Give us a writer's name and/or one article link and we'll find their profile and pull in their other articles on that site. Works with or without keywords above — with no keywords, discovery focuses on just this writer.
              </p>
            </div>

            <div className="space-y-2 border-t border-border pt-4">
              <Label>Sites to outreach <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea
                placeholder={"One site per line, e.g.\nfastcompany.com\ncreativebloq.com"}
                className="min-h-[70px] font-mono text-xs"
                value={form.seedDomains}
                onChange={(e) => setForm(f => ({ ...f, seedDomains: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">Discovery mines each site's feed/sitemap for its writers, then the Email Finder digs out their emails.</p>
            </div>

            <div className="space-y-2 border-t border-border pt-4">
              <Label>Specific articles to outreach <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Textarea
                placeholder={"One article URL per line, e.g.\nhttps://site.com/best-ai-video-tools"}
                className="min-h-[70px] font-mono text-xs"
                value={form.seedArticleUrls}
                onChange={(e) => setForm(f => ({ ...f, seedArticleUrls: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">We&apos;ll pull the author of each article into this campaign, then find their email so you can reach out.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button>
            <Button onClick={handleCreateOrSave} disabled={!form.name || (!form.keywords.length && !form.seedWriterName.trim() && !form.seedArticleUrl.trim() && !parseList(form.seedDomains).length && !parseList(form.seedArticleUrls).length) || saving}>
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {editingId ? "Save Campaign" : "Create Campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
