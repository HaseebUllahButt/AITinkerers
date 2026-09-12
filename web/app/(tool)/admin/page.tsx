"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import type { SeedTool, HarvesterConfig, Suppression, PipelineRun } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AdoptionPanel } from "@/components/admin/AdoptionPanel";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { X, Plus, Pencil, Check, Target, Swords, Compass, Hash, Brain, CheckCircle2, XCircle, Clock, Key, Loader2 } from "lucide-react";
import { PageHeader } from "@/components/layout/PageHeader";

export default function AdminPage() {
  const [seeds, setSeeds] = useState<SeedTool[]>([]);
  const [harvesters, setHarvesters] = useState<HarvesterConfig[]>([]);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [runs, setRuns] = useState<PipelineRun[]>([]);

  // Direction editor state
  const [editingBrand, setEditingBrand] = useState(false);
  const [brandName, setBrandName] = useState("");
  const [brandAliases, setBrandAliases] = useState("");

  const [newCompetitor, setNewCompetitor] = useState("");
  const [newCompetitorAliases, setNewCompetitorAliases] = useState("");

  const [newTopic, setNewTopic] = useState("");
  const [newTopicAliases, setNewTopicAliases] = useState("");

  const [subreddits, setSubreddits] = useState<string[]>([]);
  const [subredditsText, setSubredditsText] = useState("");
  const [editingSubreddits, setEditingSubreddits] = useState(false);

  // Seeds / harvesters / suppression state
  const [learnedSources, setLearnedSources] = useState<any[]>([]);

  const [newSeedName, setNewSeedName] = useState("");
  const [newSeedAliases, setNewSeedAliases] = useState("");
  const [newSupprType, setNewSupprType] = useState<"domain" | "author">("domain");
  const [newSupprValue, setNewSupprValue] = useState("");
  const [newSupprReason, setNewSupprReason] = useState("");

  // Tavily API key override
  const [tavilyKeyInput, setTavilyKeyInput] = useState("");
  const [tavilyStatus, setTavilyStatus] = useState<{ hasOverride: boolean; keys?: { id: string; label: string; masked: string; active: boolean; exhaustedThisMonth: boolean; used: number }[]; usage: { enabled: boolean; used: number; limit: number; perKeyLimit?: number; near: boolean; over: boolean; poolTotal?: number; poolActive?: number; error: { detail: string; at: number } | null } } | null>(null);
  const [savingTavilyKey, setSavingTavilyKey] = useState(false);
  const [clearingTavilyKey, setClearingTavilyKey] = useState(false);

  const loadTavilyStatus = async () => {
    const data = await fetch("/api/admin/tavily-key").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (data) setTavilyStatus(data);
  };

  const saveTavilyKey = async () => {
    if (!tavilyKeyInput.trim()) return;
    setSavingTavilyKey(true);
    const res = await fetch("/api/admin/tavily-key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: tavilyKeyInput.trim() }),
    });
    if (res.ok) {
      toast.success("Tavily key updated — takes effect immediately, no redeploy needed.");
      setTavilyKeyInput("");
      await loadTavilyStatus();
    } else {
      toast.error("Failed to save key.");
    }
    setSavingTavilyKey(false);
  };

  const clearTavilyKey = async () => {
    setClearingTavilyKey(true);
    await fetch("/api/admin/tavily-key", { method: "DELETE" });
    toast.success("Reverted to the TAVILY_API_KEY environment variable.");
    await loadTavilyStatus();
    setClearingTavilyKey(false);
  };

  // Shared sending identities (e.g. Zain) — toggle on/off, change app password, add new
  interface SharedSender { email: string; label: string; enabled: boolean; hasPassword: boolean }
  const [sharedSenders, setSharedSenders] = useState<SharedSender[]>([]);
  const [senderPwInputs, setSenderPwInputs] = useState<Record<string, string>>({});
  const [savingSenderPw, setSavingSenderPw] = useState<string | null>(null);
  const [togglingSender, setTogglingSender] = useState<string | null>(null);
  const [addingSender, setAddingSender] = useState(false);
  const [newSender, setNewSender] = useState({ email: "", label: "", app_password: "" });

  const loadSharedSenders = async () => {
    const data = await fetch("/api/admin/shared-senders").then((r) => (r.ok ? r.json() : [])).catch(() => []);
    setSharedSenders(data);
  };

  const toggleSender = async (s: SharedSender) => {
    setTogglingSender(s.email);
    await fetch(`/api/admin/shared-senders/${encodeURIComponent(s.email)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    toast.success(`${s.label} ${!s.enabled ? "enabled" : "disabled"} as a sending identity.`);
    await loadSharedSenders();
    setTogglingSender(null);
  };

  const saveSenderPassword = async (email: string) => {
    const pw = senderPwInputs[email]?.trim();
    if (!pw) return;
    setSavingSenderPw(email);
    const res = await fetch(`/api/admin/shared-senders/${encodeURIComponent(email)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_password: pw }),
    });
    if (res.ok) {
      toast.success("App password updated.");
      setSenderPwInputs((prev) => ({ ...prev, [email]: "" }));
      await loadSharedSenders();
    } else {
      toast.error("Failed to update password.");
    }
    setSavingSenderPw(null);
  };

  const addSharedSender = async () => {
    if (!newSender.email.trim() || !newSender.label.trim() || !newSender.app_password.trim()) return;
    setAddingSender(true);
    const res = await fetch("/api/admin/shared-senders", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newSender),
    });
    if (res.ok) {
      toast.success(`${newSender.label} added as a shared sender.`);
      setNewSender({ email: "", label: "", app_password: "" });
      await loadSharedSenders();
    } else {
      const d = await res.json().catch(() => ({}));
      toast.error(d.error ?? "Failed to add.");
    }
    setAddingSender(false);
  };

  const reload = async () => {
    const [s, h, sup, r, ls] = await Promise.all([
      fetch("/api/seeds").then((r) => r.json()),
      fetch("/api/harvesters").then((r) => r.json()),
      fetch("/api/suppression").then((r) => r.json()),
      fetch("/api/pipeline").then((r) => r.json()),
      fetch("/api/learned-sources").then((r) => r.json()),
    ]);
    setSeeds(s);
    setHarvesters(h);
    setSuppressions(sup);
    setRuns(r);
    setLearnedSources(Array.isArray(ls) ? ls : []);

    const brand = s.find((x: SeedTool) => x.category === "our_product");
    if (brand) {
      setBrandName(brand.name);
      setBrandAliases(brand.aliases.join(", "));
    }

    const reddit = h.find((x: HarvesterConfig) => x.name === "reddit");
    const subs = (reddit?.config?.subreddits as string[]) ?? [];
    setSubreddits(subs);
    setSubredditsText(subs.join("\n"));
  };

  useEffect(() => {
    reload().catch(() => toast.error("Failed to load admin data"));
    loadTavilyStatus();
    loadSharedSenders();
  }, []);

  // ── Direction: Our Brand ───────────────────────────────────────────────────
  const saveBrand = async () => {
    const aliases = brandAliases.split(",").map((a) => a.trim()).filter(Boolean);
    await fetch("/api/seeds", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: brandName.trim(), aliases, enabled: true, category: "our_product" }),
    });
    toast.success("Brand updated");
    setEditingBrand(false);
    reload();
  };

  // ── Direction: Competitors ─────────────────────────────────────────────────
  const addCompetitor = async () => {
    if (!newCompetitor.trim()) return;
    const aliases = newCompetitorAliases.split(",").map((a) => a.trim()).filter(Boolean);
    await fetch("/api/seeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newCompetitor.trim(), aliases, enabled: true, category: "competitor" }),
    });
    setNewCompetitor("");
    setNewCompetitorAliases("");
    toast.success(`Added competitor: ${newCompetitor}`);
    reload();
  };

  // ── Direction: Topics ──────────────────────────────────────────────────────
  const addTopic = async () => {
    if (!newTopic.trim()) return;
    const aliases = newTopicAliases.split(",").map((a) => a.trim()).filter(Boolean);
    await fetch("/api/seeds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newTopic.trim(), aliases, enabled: true, category: "topic" }),
    });
    setNewTopic("");
    setNewTopicAliases("");
    toast.success(`Added topic: ${newTopic}`);
    reload();
  };

  const deleteSeedById = async (id: string, name: string) => {
    await fetch("/api/seeds", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    toast.success(`Removed: ${name}`);
    reload();
  };

  // ── Subreddits ─────────────────────────────────────────────────────────────
  const saveSubreddits = async () => {
    const subs = subredditsText.split("\n").map((s) => s.trim()).filter(Boolean);
    const reddit = harvesters.find((h) => h.name === "reddit");
    if (!reddit) return;
    await fetch("/api/harvesters", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: reddit.id, config: { ...reddit.config, subreddits: subs } }),
    });
    setSubreddits(subs);
    setEditingSubreddits(false);
    toast.success("Subreddits saved");
    reload();
  };

  // ── Harvesters ─────────────────────────────────────────────────────────────
  const toggleHarvester = async (h: HarvesterConfig) => {
    await fetch("/api/harvesters", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: h.id, enabled: !h.enabled }),
    });
    setHarvesters((prev) => prev.map((x) => x.id === h.id ? { ...x, enabled: !x.enabled } : x));
  };

  // ── Suppression ─────────────────────────────────────────────────────────────
  const addSuppression = async () => {
    if (!newSupprValue.trim()) return;
    await fetch("/api/suppression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: newSupprType, value: newSupprValue.trim(), reason: newSupprReason }),
    });
    setNewSupprValue("");
    setNewSupprReason("");
    toast.success("Added to suppression list");
    reload();
  };

  const removeSuppression = async (id: string) => {
    await fetch("/api/suppression", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    setSuppressions((prev) => prev.filter((s) => s.id !== id));
  };

  const learnedAction = async (id: string, action: "promote" | "reject") => {
    await fetch("/api/learned-sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    toast.success(action === "promote" ? "Promoted to active sources" : "Rejected");
    reload();
  };

  const ourBrand = seeds.find((s) => s.category === "our_product");
  const competitors = seeds.filter((s) => s.category === "competitor");
  const topics = seeds.filter((s) => s.category === "topic");

  const HARVESTER_DESCRIPTIONS: Record<string, string> = {
    rss: "RSS feeds + sitemaps — best for freshness",
    gdelt: "GDELT DOC 2.0 — global news coverage, no key required",
    hackernews: "Hacker News via Algolia — early tech signal",
    reddit: "Reddit subreddit link posts — community signal",
    wordpress: "WordPress REST API adapter — blog discovery",
    ghost: "Ghost CMS + generic RSS blogs",
    commoncrawl: "Common Crawl URL index — bulk backfill",
    wayback: "Wayback Machine CDX — historical articles",
    brave: "Brave Search API — requires BRAVE_SEARCH_API_KEY",
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Admin" />

      <Tabs defaultValue="adoption" className="space-y-4">
        <TabsList className="flex w-full flex-wrap justify-start gap-1">
          <TabsTrigger value="adoption">Adoption</TabsTrigger>
          <TabsTrigger value="direction">Direction</TabsTrigger>
          <TabsTrigger value="seeds">All Seeds</TabsTrigger>
          <TabsTrigger value="harvesters">Harvesters</TabsTrigger>
          <TabsTrigger value="suppression">Suppression</TabsTrigger>
          <TabsTrigger value="pipeline">Logs</TabsTrigger>
          <TabsTrigger value="apikeys">API Keys</TabsTrigger>
          <TabsTrigger value="senders">Shared Senders</TabsTrigger>
          <TabsTrigger value="learning" className="flex items-center gap-1.5">
            <Brain className="h-3.5 w-3.5" />
            Learning
            {learnedSources.filter((s) => !s.promoted && !s.rejected).length > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground leading-none min-w-[16px] h-4">
                {learnedSources.filter((s) => !s.promoted && !s.rejected).length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="adoption" className="space-y-4">
          <AdoptionPanel />
        </TabsContent>

        {/* ── DIRECTION EDITOR ── */}
        <TabsContent value="direction" className="space-y-4">

          {/* Our Brand */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Target className="h-5 w-5 text-highlight-ink" />
                <div>
                  <CardTitle>Our Brand</CardTitle>
                  <CardDescription>
                    The product you're doing outreach for. The gap flag fires when a writer covers competitors but NOT this brand.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {editingBrand ? (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Brand name</Label>
                    <Input
                      value={brandName}
                      onChange={(e) => setBrandName(e.target.value)}
                      placeholder="e.g. imagineart"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Aliases (comma-separated)</Label>
                    <Input
                      value={brandAliases}
                      onChange={(e) => setBrandAliases(e.target.value)}
                      placeholder="e.g. imagine.art, ImagineArt, Imagine Art"
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveBrand} className="bg-primary hover:bg-primary text-primary-foreground gap-1.5">
                      <Check className="h-3.5 w-3.5" /> Save
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditingBrand(false)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-semibold">{ourBrand?.name ?? "—"}</p>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {ourBrand?.aliases.map((a) => (
                        <Badge key={a} variant="secondary" className="text-xs">{a}</Badge>
                      ))}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setEditingBrand(true)} className="gap-1.5 shrink-0">
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Competitors */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Swords className="h-5 w-5 text-destructive" />
                <div>
                  <CardTitle>Competitors</CardTitle>
                  <CardDescription>
                    Tools you're competing with. Writers who cover these but not your brand are your best outreach targets.
                    These also drive what discovery searches for across all 8 sources.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  value={newCompetitor}
                  onChange={(e) => setNewCompetitor(e.target.value)}
                  placeholder="Competitor name (e.g. leonardo)"
                  onKeyDown={(e) => e.key === "Enter" && addCompetitor()}
                />
                <Input
                  value={newCompetitorAliases}
                  onChange={(e) => setNewCompetitorAliases(e.target.value)}
                  placeholder="Aliases (e.g. Leonardo AI, Leonardo.Ai)"
                  onKeyDown={(e) => e.key === "Enter" && addCompetitor()}
                />
                <Button onClick={addCompetitor} className="bg-primary hover:bg-primary text-primary-foreground shrink-0 gap-1">
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </div>

              <div className="flex flex-wrap gap-2">
                {competitors.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-1.5 bg-muted rounded-full pl-3 pr-1.5 py-1"
                  >
                    <span className="text-sm font-medium">{c.name}</span>
                    {c.aliases.length > 0 && (
                      <span className="text-xs text-muted-foreground">({c.aliases[0]})</span>
                    )}
                    <button
                      onClick={() => deleteSeedById(c.id, c.name)}
                      className="h-4 w-4 rounded-full hover:bg-destructive/20 hover:text-destructive flex items-center justify-center transition-colors ml-0.5"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                {competitors.length === 0 && (
                  <p className="text-muted-foreground text-sm">No competitors yet</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Topic Keywords */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Compass className="h-5 w-5 text-highlight-ink" />
                <div>
                  <CardTitle>Topic Keywords</CardTitle>
                  <CardDescription>
                    Additional search directions beyond specific tools. E.g. "AI video comparison", "best generative AI art tools", "text to video roundup".
                    These go directly to GDELT, HN, Reddit, and RSS as search queries.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  value={newTopic}
                  onChange={(e) => setNewTopic(e.target.value)}
                  placeholder="Topic phrase (e.g. AI video generator review)"
                  onKeyDown={(e) => e.key === "Enter" && addTopic()}
                />
                <Input
                  value={newTopicAliases}
                  onChange={(e) => setNewTopicAliases(e.target.value)}
                  placeholder="Aliases / variations (optional)"
                />
                <Button onClick={addTopic} className="bg-primary hover:bg-primary text-primary-foreground shrink-0 gap-1">
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </div>

              <div className="flex flex-wrap gap-2">
                {topics.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center gap-1.5 bg-blue-50 dark:bg-highlight-soft border border-highlight dark:border-highlight/20 rounded-full pl-3 pr-1.5 py-1"
                  >
                    <span className="text-sm font-medium text-highlight-ink dark:text-highlight-ink">{t.name}</span>
                    <button
                      onClick={() => deleteSeedById(t.id, t.name)}
                      className="h-4 w-4 rounded-full hover:bg-destructive/20 hover:text-destructive flex items-center justify-center transition-colors ml-0.5"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                {topics.length === 0 && (
                  <p className="text-muted-foreground text-sm">
                    No topic keywords yet — add phrases that describe the content niche you want to find.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Subreddits */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Hash className="h-5 w-5 text-destructive" />
                <div>
                  <CardTitle>Subreddits</CardTitle>
                  <CardDescription>
                    Reddit communities the harvester scans for links to AI tool articles. One per line.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {editingSubreddits ? (
                <div className="space-y-3">
                  <Textarea
                    value={subredditsText}
                    onChange={(e) => setSubredditsText(e.target.value)}
                    rows={8}
                    placeholder={"StableDiffusion\naivideo\nartificial\nmidjourney\nsingularity"}
                    className="font-mono text-sm"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={saveSubreddits} className="bg-primary hover:bg-primary text-primary-foreground gap-1.5">
                      <Check className="h-3.5 w-3.5" /> Save
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => { setEditingSubreddits(false); setSubredditsText(subreddits.join("\n")); }}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-wrap gap-1.5">
                    {subreddits.map((s) => (
                      <Badge key={s} variant="outline" className="text-xs gap-1">
                        <span className="text-muted-foreground">r/</span>{s}
                      </Badge>
                    ))}
                    {subreddits.length === 0 && <p className="text-muted-foreground text-sm">No subreddits configured</p>}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setEditingSubreddits(true)} className="gap-1.5 shrink-0">
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── ALL SEEDS (raw view) ── */}
        <TabsContent value="seeds" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>All Seed Keywords</CardTitle>
              <CardDescription>All seeds across all categories. Use the Direction tab for the better editor.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  value={newSeedName}
                  onChange={(e) => setNewSeedName(e.target.value)}
                  placeholder="Tool name"
                  onKeyDown={(e) => e.key === "Enter" && (async () => {
                    if (!newSeedName.trim()) return;
                    const aliases = newSeedAliases.split(",").map((a) => a.trim()).filter(Boolean);
                    await fetch("/api/seeds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newSeedName.trim(), aliases }) });
                    setNewSeedName(""); setNewSeedAliases(""); reload(); toast.success(`Added: ${newSeedName}`);
                  })()}
                />
                <Input
                  value={newSeedAliases}
                  onChange={(e) => setNewSeedAliases(e.target.value)}
                  placeholder="Aliases (comma-separated)"
                />
                <Button
                  onClick={async () => {
                    if (!newSeedName.trim()) return;
                    const aliases = newSeedAliases.split(",").map((a) => a.trim()).filter(Boolean);
                    await fetch("/api/seeds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newSeedName.trim(), aliases }) });
                    setNewSeedName(""); setNewSeedAliases(""); reload(); toast.success(`Added: ${newSeedName}`);
                  }}
                  className="bg-primary hover:bg-primary text-primary-foreground shrink-0"
                >Add</Button>
              </div>
              <Separator />
              <div className="space-y-1.5 max-h-96 overflow-y-auto">
                {seeds.map((seed) => (
                  <div key={seed.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-muted/50 hover:bg-muted transition-colors">
                    <Badge variant="outline" className={`text-xs shrink-0 ${
                      seed.category === "our_product" ? "border-highlight/40 text-highlight-ink" :
                      seed.category === "topic" ? "border-highlight/50 text-highlight-ink dark:text-highlight-ink" :
                      "border-border"
                    }`}>
                      {seed.category === "our_product" ? "us" : seed.category === "topic" ? "topic" : "competitor"}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium">{seed.name}</span>
                      {seed.aliases?.length > 0 && (
                        <span className="text-xs text-muted-foreground ml-2">{seed.aliases.join(", ")}</span>
                      )}
                    </div>
                    <button
                      onClick={() => deleteSeedById(seed.id, seed.name)}
                      className="h-6 w-6 rounded hover:bg-destructive/20 hover:text-destructive flex items-center justify-center transition-colors shrink-0"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── HARVESTERS ── */}
        <TabsContent value="harvesters">
          <Card>
            <CardHeader>
              <CardTitle>Discovery Sources</CardTitle>
              <CardDescription>Toggle which harvesters run during discovery.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {harvesters.map((h) => (
                <div key={h.id} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium capitalize">{h.name}</p>
                    <p className="text-xs text-muted-foreground">{HARVESTER_DESCRIPTIONS[h.name] ?? h.name}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    {h.name === "brave" && <Badge variant="outline" className="text-xs">needs key</Badge>}
                    <Switch checked={h.enabled} onCheckedChange={() => toggleHarvester(h)} />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── API KEYS ── */}
        <TabsContent value="apikeys" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Key className="h-4 w-4" />Tavily Search API Key</CardTitle>
              <CardDescription>
                Swap the Tavily key at any time — takes effect immediately, no redeploy needed. Useful when the free-tier
                monthly quota (1,000 searches) runs out.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {tavilyStatus && (
                <div className="flex items-center gap-3 flex-wrap text-sm">
                  <Badge variant="outline" className={
                    !tavilyStatus.usage.enabled ? "text-muted-foreground" :
                    tavilyStatus.usage.over ? "text-destructive border-destructive/30 bg-destructive/10" :
                    tavilyStatus.usage.near ? "text-warning border-warning/30 bg-warning/10" :
                    "text-success border-success/40 bg-success/15"
                  }>
                    {tavilyStatus.usage.enabled ? `${tavilyStatus.usage.used}/${tavilyStatus.usage.limit} used this month` : "Not configured"}
                  </Badge>
                  <Badge variant="outline" className="text-muted-foreground">
                    {tavilyStatus.hasOverride ? "Using an admin-set override key" : "Using the TAVILY_API_KEY environment variable"}
                  </Badge>
                  {tavilyStatus.usage.error && (
                    <span className="text-xs text-destructive">Last error: {tavilyStatus.usage.error.detail}</span>
                  )}
                </div>
              )}
              {/* Per-key breakdown — confirms load is spread across every key in the rotating pool. */}
              {tavilyStatus?.keys && tavilyStatus.keys.length > 0 && (
                <div className="rounded-lg border border-border/60 divide-y divide-border/60 text-sm">
                  <div className="px-3 py-2 text-xs text-muted-foreground">
                    {tavilyStatus.keys.length} key{tavilyStatus.keys.length === 1 ? "" : "s"} in the rotating pool · searches go to the least-used active key
                  </div>
                  {tavilyStatus.keys.map((k) => {
                    const lim = tavilyStatus.usage.perKeyLimit ?? 1000;
                    const pct = Math.min(100, Math.round((k.used / lim) * 100));
                    return (
                      <div key={k.id} className="flex items-center gap-3 px-3 py-2">
                        <code className="text-xs">{k.masked}</code>
                        {k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}
                        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className={`h-full ${k.exhaustedThisMonth ? "bg-destructive" : pct >= 90 ? "bg-warning" : "bg-success"}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs tabular-nums text-muted-foreground">{k.used.toLocaleString()}/{lim.toLocaleString()}</span>
                        <span className={`text-xs ${k.exhaustedThisMonth ? "text-destructive" : "text-success"}`}>{k.exhaustedThisMonth ? "exhausted" : "active"}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder="tvly-..."
                  value={tavilyKeyInput}
                  onChange={(e) => setTavilyKeyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveTavilyKey(); }}
                />
                <Button onClick={saveTavilyKey} disabled={!tavilyKeyInput.trim() || savingTavilyKey} className="bg-primary hover:bg-primary text-primary-foreground shrink-0">
                  {savingTavilyKey && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                  Save
                </Button>
                {tavilyStatus?.hasOverride && (
                  <Button variant="outline" onClick={clearTavilyKey} disabled={clearingTavilyKey} className="shrink-0">
                    {clearingTavilyKey && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                    Revert to env var
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Get a free key (1,000 searches/mo, no card) at{" "}
                <a href="https://tavily.com" target="_blank" rel="noreferrer" className="text-highlight-ink hover:underline">tavily.com</a>.
                Saving resets the usage counter shown here and in the navbar, since a new key starts its own quota.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── SHARED SENDERS ── */}
        <TabsContent value="senders" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Shared Sending Identities</CardTitle>
              <CardDescription>
                Team inboxes anyone can send through from the emails page's "Send from" picker — toggle on/off, or update
                the Gmail app password when it changes. Whoever actually clicks Send is still CC'd and shown in the
                Sending page, so nothing gets lost.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {sharedSenders.length === 0 ? (
                <p className="text-muted-foreground text-sm text-center py-4">No shared senders configured yet</p>
              ) : sharedSenders.map((s) => (
                <div key={s.email} className="rounded-lg bg-muted/50 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{s.label}</p>
                      <p className="text-xs text-muted-foreground truncate">{s.email}</p>
                    </div>
                    {!s.hasPassword && <Badge variant="outline" className="text-warning border-warning/40 text-xs shrink-0">no password set</Badge>}
                    <Switch checked={s.enabled} disabled={togglingSender === s.email} onCheckedChange={() => toggleSender(s)} />
                  </div>
                  <div className="flex gap-2">
                    <Input
                      type="password"
                      placeholder="New app password…"
                      value={senderPwInputs[s.email] ?? ""}
                      onChange={(e) => setSenderPwInputs((prev) => ({ ...prev, [s.email]: e.target.value }))}
                      onKeyDown={(ev) => { if (ev.key === "Enter") saveSenderPassword(s.email); }}
                      className="h-8 text-xs"
                    />
                    <Button
                      size="sm" variant="outline" className="h-10 text-xs shrink-0"
                      disabled={!senderPwInputs[s.email]?.trim() || savingSenderPw === s.email}
                      onClick={() => saveSenderPassword(s.email)}
                    >
                      {savingSenderPw === s.email && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                      Update
                    </Button>
                  </div>
                </div>
              ))}
              <Separator />
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Add a shared sender</p>
                <div className="flex flex-wrap gap-2">
                  <Input placeholder="Display name (e.g. Zain)" value={newSender.label} onChange={(e) => setNewSender((f) => ({ ...f, label: e.target.value }))} className="flex-1 min-w-[140px]" />
                  <Input placeholder="Gmail address" value={newSender.email} onChange={(e) => setNewSender((f) => ({ ...f, email: e.target.value }))} className="flex-1 min-w-[180px]" />
                  <Input type="password" placeholder="App password" value={newSender.app_password} onChange={(e) => setNewSender((f) => ({ ...f, app_password: e.target.value }))} className="flex-1 min-w-[140px]" />
                  <Button onClick={addSharedSender} disabled={addingSender || !newSender.email.trim() || !newSender.label.trim() || !newSender.app_password.trim()} className="bg-primary hover:bg-primary text-primary-foreground shrink-0">
                    {addingSender && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                    Add
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── SUPPRESSION ── */}
        <TabsContent value="suppression" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Suppression List</CardTitle>
              <CardDescription>Domains and authors excluded from results and exports.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <select
                  value={newSupprType}
                  onChange={(e) => setNewSupprType(e.target.value as "domain" | "author")}
                  className="border border-input bg-background rounded-md px-3 py-2 text-sm"
                >
                  <option value="domain">Domain</option>
                  <option value="author">Author</option>
                  <option value="url">URL</option>
                </select>
                <Input value={newSupprValue} onChange={(e) => setNewSupprValue(e.target.value)} placeholder="e.g. spamsite.com" />
                <Input value={newSupprReason} onChange={(e) => setNewSupprReason(e.target.value)} placeholder="Reason (optional)" />
                <Button onClick={addSuppression} className="bg-primary hover:bg-primary text-primary-foreground shrink-0">Add</Button>
              </div>
              <Separator />
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {suppressions.length === 0 ? (
                  <p className="text-muted-foreground text-sm text-center py-4">No suppressions yet</p>
                ) : suppressions.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/50">
                    <Badge variant="outline" className="text-xs shrink-0">{s.type}</Badge>
                    <p className="text-sm flex-1 truncate">{s.value}</p>
                    {s.reason && <p className="text-xs text-muted-foreground hidden sm:block truncate max-w-xs">{s.reason}</p>}
                    <Button variant="ghost" size="sm" onClick={() => removeSuppression(s.id)} className="h-10 w-10 p-0 text-muted-foreground hover:text-destructive shrink-0">
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── PIPELINE LOGS ── */}
        <TabsContent value="pipeline">
          <Card>
            <CardHeader>
              <CardTitle>Pipeline History</CardTitle>
              <CardDescription>Recent discovery runs.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {runs.length === 0 ? (
                  <p className="text-muted-foreground text-sm text-center py-8">No runs yet.</p>
                ) : runs.map((run) => (
                  <div key={run.id} className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <div className={`w-2 h-2 rounded-full shrink-0 ${
                      run.status === "completed" ? "bg-primary" :
                      run.status === "failed" ? "bg-destructive" : "bg-warning animate-pulse"
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className={`text-xs ${
                          run.status === "completed" ? "border-success/40 text-success" :
                          run.status === "failed" ? "border-destructive/50 text-destructive" : "border-warning/50 text-warning"
                        }`}>{run.status}</Badge>
                        <span className="text-xs text-muted-foreground">{new Date(run.started_at).toLocaleString()}</span>
                      </div>
                      {run.stats && Object.keys(run.stats).length > 0 && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {(run.stats as Record<string, number>).processed ?? 0} processed · {(run.stats as Record<string, number>).hitsDiscovered ?? 0} hits
                        </p>
                      )}
                      {run.error && <p className="text-xs text-destructive mt-0.5 truncate">{run.error}</p>}
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {run.finished_at
                        ? `${Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)}s`
                        : "running…"}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── LEARNING ── */}
        <TabsContent value="learning" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Brain className="h-5 w-5 text-highlight-ink" />
                <div>
                  <CardTitle>Self-Learning Sources</CardTitle>
                  <CardDescription>
                    Every pipeline run auto-discovers new subreddits and domains from outbound links and Reddit snippets. All are automatically added to future discovery runs.
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {learnedSources.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No learned sources yet — run a discovery pipeline first.
                </p>
              ) : (
                <>
                  {/* Subreddits */}
                  {learnedSources.filter((s) => s.type === "subreddit").length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold flex items-center gap-1.5">
                        <Hash className="h-4 w-4 text-highlight-ink" />
                        Subreddits ({learnedSources.filter((s) => s.type === "subreddit").length})
                        <span className="text-xs font-normal text-muted-foreground ml-1">— added to Reddit harvester</span>
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {learnedSources.filter((s) => s.type === "subreddit").map((source) => (
                          <Badge key={source.id} variant={source.promoted ? "secondary" : "outline"} className="text-xs gap-1.5">
                            <span className="text-highlight-ink font-mono">r/</span>{source.value}
                            <span className="text-muted-foreground">{source.times_seen}× · {Math.round(source.score)}pt</span>
                            {source.promoted && <CheckCircle2 className="h-3 w-3 text-success" />}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Domains */}
                  {learnedSources.filter((s) => s.type === "domain").length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-sm font-semibold flex items-center gap-1.5">
                        <Compass className="h-4 w-4 text-success" />
                        Domains ({learnedSources.filter((s) => s.type === "domain").length})
                        <span className="text-xs font-normal text-muted-foreground ml-1">— added to RSS harvester (2+ links needed)</span>
                      </h3>
                      <div className="flex flex-wrap gap-2">
                        {learnedSources.filter((s) => s.type === "domain").map((source) => (
                          <Badge key={source.id} variant={source.promoted ? "secondary" : "outline"} className="text-xs gap-1.5">
                            {source.value}
                            <span className="text-muted-foreground">{source.times_seen}× · {Math.round(source.score)}pt</span>
                            {source.promoted && <CheckCircle2 className="h-3 w-3 text-success" />}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
