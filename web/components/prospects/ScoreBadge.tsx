"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Score } from "@/lib/types";

interface ScoreBadgeProps {
  score: Score | null;
  size?: "sm" | "md";
}

function scoreColor(n: number): string {
  if (n >= 70) return "text-success border-success/40 bg-success/15";
  if (n >= 45) return "text-warning border-warning/40 bg-warning/10";
  return "text-muted-foreground border-border bg-muted/50";
}

export function ScoreBadge({ score, size = "md" }: ScoreBadgeProps) {
  const composite = score?.composite ?? 0;

  return (
    <Tooltip>
      <TooltipTrigger>
        <div className={`inline-flex items-center gap-1 border rounded-full font-mono font-bold cursor-help
          ${size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"}
          ${scoreColor(composite)}`}>
          <span>{composite}</span>
          <span className="opacity-40 font-normal text-xs">/100</span>
        </div>
      </TooltipTrigger>
      {score && (
        <TooltipContent side="left" className="p-3 w-52">
          <p className="font-semibold mb-2">Score breakdown</p>
          <div className="space-y-1.5 text-xs">
            {[
              ["Relevance", score.relevance, 35],
              ["Competitor overlap", score.competitor_overlap, 20],
              ["Authority", score.authority, 20],
              ["Freshness", score.freshness, 15],
              ["Contact confidence", score.contact_confidence, 10],
            ].map(([label, val, weight]) => (
              <div key={String(label)} className="flex justify-between items-center gap-2">
                <span className="text-muted-foreground">{label} ({weight}%)</span>
                <span className="font-mono font-bold">{val}</span>
              </div>
            ))}
          </div>
        </TooltipContent>
      )}
    </Tooltip>
  );
}
