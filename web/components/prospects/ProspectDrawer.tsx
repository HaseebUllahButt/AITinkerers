"use client";

import { useState, useEffect } from "react";
import type { ProspectCard } from "@/lib/types";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ScoreBadge } from "./ScoreBadge";
import { ContactSurface } from "./ContactSurface";
import { ExternalLink, Search, Loader2, CheckCircle2, AlertTriangle, Link2, MailCheck, ShieldAlert, ShieldCheck, Ban } from "lucide-react";

const SAFETY_CATEGORY_LABEL: Record<string, string> = {
  nsfw: "NSFW",
  hate_violence_illegal: "Hate/violence/illegal",
  political_controversy: "Political controversy",
};

function safetyTone(score: number): { color: string; label: string } {
  if (score >= 80) return { color: "text-success border-success/40 bg-success/15", label: "Clean" };
  if (score >= 50) return { color: "text-warning border-warning/30 bg-warning/10", label: "Some flags" };
  return { color: "text-destructive border-destructive/30 bg-destructive/10", label: "Flagged" };
}

function linkedinOf(contacts: { type: string; value: string }[]): string | null {
  const c = contacts?.find((c) => c.type === "linkedin");
  if (!c) return null;
  return c.value.startsWith("http") ? c.value : `https://${c.value}`;
}

interface ProspectDrawerProps {
  prospect: ProspectCard | null;
  open: boolean;
  onClose: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">{title}</p>
      {children}
    </div>
  );
}

export function ProspectDrawer({ prospect, open, onClose }: ProspectDrawerProps) {
  const [refinding, setRefinding] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [refindResult, setRefindResult] = useState<{ email: string | null; source: string | null; status?: string; issues?: string[] } | null>(null);

  // "Emailed" toggle — reflects effective contacted state (history or manual override).
  const [contacted, setContacted] = useState<boolean | null>(null);
  const [savingContacted, setSavingContacted] = useState(false);
  const authorId = prospect?.author?.id;
  useEffect(() => {
    setContacted(null);
    if (!open || !authorId) return;
    fetch(`/api/authors/${authorId}/contacted`).then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setContacted(!!d.contacted); }).catch(() => {});
  }, [open, authorId]);

  async function toggleContacted(next: boolean) {
    if (!authorId) return;
    setContacted(next); setSavingContacted(true);
    await fetch(`/api/authors/${authorId}/contacted`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contacted: next }),
    }).catch(() => {});
    setSavingContacted(false);
  }

  // "Discarded" toggle — hide this author from every workflow.
  const [discarded, setDiscarded] = useState<boolean>(false);
  const [savingDiscarded, setSavingDiscarded] = useState(false);
  useEffect(() => { setDiscarded(!!prospect?.author?.discarded); }, [prospect?.author?.discarded, open]);
  async function toggleDiscarded(next: boolean) {
    if (!authorId) return;
    setDiscarded(next); setSavingDiscarded(true);
    await fetch(`/api/authors/${authorId}/discard`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discarded: next }),
    }).catch(() => {});
    setSavingDiscarded(false);
  }

  async function refind(authorId: string) {
    setRefinding(true); setSteps([]); setRefindResult(null);
    try {
      const r = await fetch(`/api/authors/${authorId}/refind`, { method: "POST" }).then((res) => res.json());
      setSteps(r.steps ?? []);
      setRefindResult({ email: r.email ?? null, source: r.source ?? null, status: r.status, issues: r.issues });
    } catch { setRefindResult({ email: null, source: null, status: "error", issues: ["request failed"] }); }
    setRefinding(false);
  }

  if (!prospect) return null;
  const { author, articles, contacts, mentions, score, domain, flaggedContent } = prospect;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col p-0 gap-0 overflow-hidden">

        {/* ── Header ── */}
        <div className="flex items-start gap-4 p-6 pb-5 border-b border-border shrink-0">
          <Avatar className="h-14 w-14 shrink-0">
            <AvatarImage src={author.avatar_url ?? undefined} alt={author.full_name} />
            <AvatarFallback className="bg-primary text-primary-foreground font-bold text-lg">
              {author.full_name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-base leading-tight truncate">{author.full_name}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">{author.role ?? "Writer"}</p>
            <p className="text-xs text-muted-foreground/60 mt-0.5 truncate">
              {domain?.name ?? domain?.host ?? "Unknown publication"}
            </p>
            {linkedinOf(contacts) && (
              <a
                href={linkedinOf(contacts)!}
                target="_blank"
                rel="noreferrer"
                className="mt-1.5 inline-flex items-center gap-1 text-xs text-[#0a66c2] hover:underline"
              >
                <Link2 className="h-3 w-3" />
                {linkedinOf(contacts)!.replace(/^https?:\/\/(www\.)?/, "")}
              </a>
            )}
          </div>
          <ScoreBadge score={score} />
        </div>

        {/* Emailed toggle — mark contacted (won't email again) or clear it to email again */}
        <div className="flex items-center justify-between gap-3 px-6 py-3 border-b border-border shrink-0 bg-muted/10">
          <div className="flex items-center gap-2 text-sm">
            <MailCheck className={`h-4 w-4 ${contacted ? "text-success" : "text-muted-foreground/50"}`} />
            <span className="font-medium">Emailed</span>
            <span className="text-xs text-muted-foreground">
              {contacted === null ? "checking…" : contacted ? "won't be contacted again" : "eligible for outreach"}
            </span>
          </div>
          <Switch
            checked={!!contacted}
            disabled={contacted === null || savingContacted}
            onCheckedChange={toggleContacted}
          />
        </div>

        {/* Discarded toggle — hide from every workflow */}
        <div className={`flex items-center justify-between gap-3 px-6 py-3 border-b border-border shrink-0 ${discarded ? "bg-destructive/10" : "bg-muted/10"}`}>
          <div className="flex items-center gap-2 text-sm">
            <Ban className={`h-4 w-4 ${discarded ? "text-destructive" : "text-muted-foreground/50"}`} />
            <span className="font-medium">Discarded</span>
            <span className="text-xs text-muted-foreground">
              {discarded ? "hidden from all workflows" : "eligible to appear in workflows"}
            </span>
          </div>
          <Switch checked={discarded} disabled={savingDiscarded} onCheckedChange={toggleDiscarded} />
        </div>

        {/* ── Scrollable body ── */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* Bio */}
          {author.description && (
            <Section title="About">
              <p className="text-sm leading-relaxed text-muted-foreground">{author.description}</p>
            </Section>
          )}

          {/* Score breakdown */}
          {score && (
            <Section title="Score breakdown">
              <div className="grid grid-cols-1 gap-2">
                {([
                  ["Relevance", score.relevance, "35%"],
                  ["Authority", score.authority, "20%"],
                  ["Competitor overlap", score.competitor_overlap, "20%"],
                  ["Freshness", score.freshness, "15%"],
                  ["Contact confidence", score.contact_confidence, "10%"],
                ] as [string, number, string][]).map(([label, val, weight]) => (
                  <div key={label} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground w-36 shrink-0">{label}</span>
                    <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${val ?? 0}%` }} />
                    </div>
                    <span className="text-xs font-mono font-semibold w-7 text-right">{val ?? 0}</span>
                    <span className="text-xs text-muted-foreground/50 w-8 text-right">{weight}</span>
                  </div>
                ))}
                <div className="flex items-center gap-3 pt-1 border-t border-border mt-1">
                  <span className="text-xs font-semibold w-36 shrink-0">Composite</span>
                  <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
                    <div className="h-full bg-primary rounded-full" style={{ width: `${score.composite ?? 0}%` }} />
                  </div>
                  <span className="text-sm font-mono font-bold w-7 text-right">{score.composite ?? 0}</span>
                  <span className="w-8" />
                </div>
              </div>
            </Section>
          )}

          {/* Safety screening — NSFW / hate-violence-illegal / political-controversy */}
          {author.safety_score != null && (() => {
            // Postgres numeric columns come back as strings (e.g. "92.00") — coerce once.
            const score = Math.round(Number(author.safety_score));
            const tone = safetyTone(score);
            return (
              <Section title="Safety">
                <div className="flex items-center gap-2">
                  {score >= 80
                    ? <ShieldCheck className="h-4 w-4 text-success" />
                    : <ShieldAlert className="h-4 w-4 text-warning" />}
                  <Badge variant="outline" className={`text-xs ${tone.color}`}>
                    {tone.label} · {score}/100
                  </Badge>
                </div>
                {/* Explains the score in one sentence — no need to open the flagged posts to see why.
                    Always shows something here, even when clean, so the section is never silent. */}
                <p className="text-xs text-muted-foreground leading-relaxed pt-1">
                  {author.safety_summary ?? "No safety concerns found — nothing flagged in any of their articles."}
                </p>
                {(flaggedContent?.length ?? 0) > 0 && (
                  <div className="space-y-1.5 pt-1">
                    {flaggedContent!.map((f) => (
                      <div key={f.id} className="flex items-start gap-2 text-xs bg-destructive/5 border border-destructive/20 rounded-md px-2.5 py-1.5">
                        <AlertTriangle className="h-3 w-3 text-destructive shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <p className="text-muted-foreground">
                            <span className="text-destructive font-medium">{SAFETY_CATEGORY_LABEL[f.category] ?? f.category}</span>
                            {" "}({f.severity})
                          </p>
                          {f.reason && <p className="text-muted-foreground/80 italic">{f.reason}</p>}
                          {f.article?.title && (
                            f.article.url_canonical
                              ? <a href={f.article.url_canonical} target="_blank" rel="noreferrer" className="text-foreground hover:underline truncate block">{f.article.title}</a>
                              : <p className="text-foreground truncate">{f.article.title}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            );
          })()}

          {/* Contacts */}
          <Section title={`Contacts (${contacts.length})`}>
            {contacts.length > 0
              ? <ContactSurface contacts={contacts} />
              : <p className="text-sm text-muted-foreground">No contacts found</p>
            }
          </Section>

          {/* Re-find email — runs the full cascade for just this person, verbose */}
          <Section title="Find email">
            <Button size="sm" variant="outline" className="gap-1.5" disabled={refinding} onClick={() => refind(author.id)}>
              {refinding ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Searching…</> : <><Search className="h-3.5 w-3.5" />Re-find email</>}
            </Button>
            {refindResult && (
              refindResult.email
                ? <p className="mt-2 text-sm flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4 text-success" /><span className="text-success font-mono">{refindResult.email}</span><span className="text-xs text-muted-foreground">{refindResult.source}</span></p>
                : refindResult.status === "error"
                  ? <p className="mt-2 text-sm flex items-start gap-1.5 text-warning/90"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /><span>Couldn&apos;t complete — {refindResult.issues?.join(" · ") ?? "an API failed"}. Not confirmed missing; try again.</span></p>
                  : <p className="mt-2 text-sm text-muted-foreground">No email found</p>
            )}
            {steps.length > 0 && (
              <div className="mt-2 space-y-1 max-h-56 overflow-y-auto rounded-md border border-border bg-muted/20 p-2">
                {steps.map((s, i) => {
                  const warn = s.startsWith("!");
                  return (
                    <div key={i} className={`flex items-center gap-2 text-xs font-mono ${warn ? "text-warning/80" : "text-muted-foreground/70"}`}>
                      <span className={`h-1 w-1 rounded-full shrink-0 ${warn ? "bg-warning/60" : "bg-muted-foreground/30"}`} />
                      <span className="truncate">{s}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Section>

          {/* Tools */}
          {mentions.length > 0 && (
            <Section title={`AI tools covered (${mentions.length})`}>
              <div className="flex flex-wrap gap-1.5">
                {mentions.map((tool) => (
                  <Badge key={tool} variant="secondary" className="text-xs">{tool}</Badge>
                ))}
              </div>
            </Section>
          )}

          {/* Articles */}
          <Section title={`Articles (${articles.length})`}>
            {articles.length === 0
              ? <p className="text-sm text-muted-foreground">No articles found</p>
              : (
                <div className="space-y-1">
                  {articles.map((article) => (
                    <a
                      key={article.id}
                      href={article.url_canonical}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-3 p-2.5 rounded-lg hover:bg-muted transition-colors group"
                    >
                      {article.lead_image_url ? (
                        <img
                          src={article.lead_image_url}
                          alt=""
                          className="w-12 h-9 object-cover rounded shrink-0 bg-muted"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                      ) : (
                        <div className="w-12 h-9 bg-muted rounded shrink-0 flex items-center justify-center text-base">📰</div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm line-clamp-2 leading-snug text-foreground/80 group-hover:text-foreground transition-colors">
                          {article.title ?? article.url_canonical}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          {article.archetype && (
                            <Badge variant="outline" className="text-xs px-1 py-0 h-4 capitalize">{article.archetype}</Badge>
                          )}
                          {article.published_at && (
                            <span className="text-xs text-muted-foreground/50">
                              {new Date(article.published_at).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground shrink-0 mt-0.5 transition-colors" />
                    </a>
                  ))}
                </div>
              )
            }
          </Section>

          {/* Provenance */}
          <Section title="Source">
            <div className="rounded-lg bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
              Discovered via <span className="font-medium text-foreground">{author.source ?? "unknown"}</span>
              {domain?.host && <> · <span className="font-medium text-foreground">{domain.host}</span></>}
            </div>
            {(author.same_as_json as string[])?.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {(author.same_as_json as string[]).map((link) => (
                  <a
                    key={link}
                    href={link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-highlight-ink hover:underline truncate max-w-full"
                  >
                    {link}
                  </a>
                ))}
              </div>
            )}
          </Section>

        </div>
      </SheetContent>
    </Sheet>
  );
}
