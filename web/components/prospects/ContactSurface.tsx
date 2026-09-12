"use client";

import type { Contact } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const TYPE_META: Record<string, { icon: string; label: string; color: string }> = {
  mailto: { icon: "✉️", label: "Email", color: "text-highlight-ink hover:text-highlight-ink" },
  author_page: { icon: "🔗", label: "Author page", color: "text-highlight-ink hover:text-highlight-ink" },
  form: { icon: "📋", label: "Contact form", color: "text-warning hover:text-warning" },
  twitter: { icon: "𝕏", label: "Twitter/X", color: "text-foreground hover:text-foreground" },
  linkedin: { icon: "in", label: "LinkedIn", color: "text-highlight-ink hover:text-highlight-ink" },
  mastodon: { icon: "🐘", label: "Mastodon", color: "text-highlight-ink hover:text-highlight-ink" },
  youtube: { icon: "▶", label: "YouTube", color: "text-destructive hover:text-destructive" },
  instagram: { icon: "📸", label: "Instagram", color: "text-highlight-ink hover:text-highlight-ink" },
};

interface ContactSurfaceProps {
  contacts: Contact[];
  compact?: boolean;
}

export function ContactSurface({ contacts, compact = false }: ContactSurfaceProps) {
  if (!contacts.length) {
    return <span className="text-xs text-muted-foreground">No contacts found</span>;
  }

  // Prioritize: email > author_page > form > social
  const sorted = [...contacts].sort((a, b) => b.confidence - a.confidence);
  const shown = compact ? sorted.slice(0, 3) : sorted;

  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((c) => {
        const meta = TYPE_META[c.type] ?? { icon: "🌐", label: c.type, color: "text-muted-foreground" };
        return (
          <Tooltip key={c.id}>
            <TooltipTrigger className="inline-flex">
              <a
                href={c.value}
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full
                  bg-muted border border-border transition-colors ${meta.color}`}
                onClick={(e) => e.stopPropagation()}
              >
                <span>{meta.icon}</span>
                {!compact && <span>{meta.label}</span>}
                <span className="opacity-40 text-xs">{Math.round(c.confidence * 100)}%</span>
              </a>
            </TooltipTrigger>
            <TooltipContent className="text-xs max-w-xs truncate">
              {c.value}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
