"use client";

import { useState } from "react";
import type { ProspectCard as ProspectCardType } from "@/lib/types";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScoreBadge } from "./ScoreBadge";
import { ContactSurface } from "./ContactSurface";
import { ExternalLink } from "lucide-react";

const ARCHETYPE_LABELS: Record<string, string> = {
  listicle: "Listicle",
  comparison: "Comparison",
  review: "Review",
  explainer: "Explainer",
  news: "News",
};

interface ProspectCardProps {
  prospect: ProspectCardType;
  onClick: () => void;
}

const CHECK_TONE: Record<string, string> = {
  pass: "bg-success",
  fail: "bg-destructive",
  unverified: "bg-muted-foreground/30",
};

export function ProspectCard({ prospect, onClick }: ProspectCardProps) {
  const { author, articles, contacts, mentions, score, domain, qualification } = prospect;
  const [imgError, setImgError] = useState(false);

  const topArticles = articles.slice(0, 2);
  const competitorTools = mentions.slice(0, 4);

  return (
    <Card
      onClick={onClick}
      className="cursor-pointer hover:shadow-md transition-all hover:border-highlight/40 group"
    >
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start gap-3">
          <Avatar className="h-10 w-10 shrink-0">
            <AvatarImage src={author.avatar_url ?? undefined} alt={author.full_name} />
            <AvatarFallback className="bg-primary text-primary-foreground text-sm font-semibold">
              {author.full_name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>

          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold text-sm leading-tight truncate">{author.full_name}</p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {author.role ?? "Writer"} · {domain?.name ?? domain?.host ?? "Unknown"}
                </p>
              </div>
              <ScoreBadge score={score} size="sm" />
            </div>
          </div>
        </div>

        {/* Qualification (from the Outreach Requirement filters: DR / traffic / US / relevancy) */}
        {qualification && (
          <div className="flex items-center flex-wrap gap-1.5">
            <Badge
              variant="outline"
              className={qualification.qualified
                ? "text-xs px-1.5 py-0 h-4 text-success border-success/40 bg-success/15"
                : "text-xs px-1.5 py-0 h-4 text-warning border-warning/40 bg-warning/10"}
            >
              {qualification.qualified ? "Qualified" : "Review"}
            </Badge>
            {qualification.dr != null && (
              <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4 font-normal tabular-nums">DR {Math.round(qualification.dr)}</Badge>
            )}
            <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4 font-normal tabular-nums">Fit {qualification.fit}</Badge>
            <div className="flex items-center gap-1 ml-auto">
              {qualification.checks.map((c) => (
                <span key={c.label} title={`${c.label}: ${c.state}`} className={`h-1.5 w-1.5 rounded-full ${CHECK_TONE[c.state]}`} />
              ))}
            </div>
          </div>
        )}

        {/* Description */}
        {author.description && (
          <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{author.description}</p>
        )}

        {/* Tool chips */}
        {competitorTools.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {competitorTools.map((tool) => (
              <Badge key={tool} variant="secondary" className="text-xs px-1.5 py-0 h-4 font-normal">
                {tool}
              </Badge>
            ))}
            {mentions.length > 4 && (
              <Badge variant="outline" className="text-xs px-1.5 py-0 h-4 font-normal">
                +{mentions.length - 4}
              </Badge>
            )}
          </div>
        )}

        {/* Articles */}
        {topArticles.length > 0 && (
          <div className="space-y-1.5">
            {topArticles.map((article) => (
              <a
                key={article.id}
                href={article.url_canonical}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-2 p-1.5 rounded-md hover:bg-muted transition-colors group/article"
              >
                {article.lead_image_url && !imgError ? (
                  <div className="relative w-9 h-9 shrink-0 rounded overflow-hidden bg-muted">
                    <img
                      src={article.lead_image_url}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={() => setImgError(true)}
                    />
                  </div>
                ) : (
                  <div className="w-9 h-9 shrink-0 rounded bg-muted flex items-center justify-center text-base">
                    📰
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs leading-tight line-clamp-2 group-hover/article:text-foreground text-muted-foreground transition-colors">
                    {article.title ?? article.url_canonical}
                  </p>
                  {article.archetype && (
                    <span className="text-xs text-muted-foreground/70 capitalize">
                      {ARCHETYPE_LABELS[article.archetype] ?? article.archetype}
                    </span>
                  )}
                </div>
                <ExternalLink className="h-3 w-3 text-muted-foreground/50 group-hover/article:text-muted-foreground shrink-0 transition-colors" />
              </a>
            ))}
          </div>
        )}

        {/* Contacts */}
        <div className="pt-2 border-t border-border">
          <ContactSurface contacts={contacts} compact />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-xs text-muted-foreground/60">
          <span>via {author.source ?? "unknown"}</span>
          <span>{articles.length} article{articles.length !== 1 ? "s" : ""}</span>
        </div>
      </CardContent>
    </Card>
  );
}
