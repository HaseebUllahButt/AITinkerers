import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The one page header.
 *
 * Before this, each page wrote its own: fifteen different h1 class strings, titles from 14px to
 * 36px, some with an icon and some without, some with a paragraph of onboarding copy that never
 * went away, and six pages whose "title" was really the heading of a side panel. Landing on a new
 * page meant re-learning where the title was.
 *
 * Now: title on the left at one size, an optional single-sentence description under it, actions on
 * the right on the same baseline. The icon is quiet (muted, not accent) because the sidebar already
 * shows the page's icon in colour and two teal glyphs for one page is noise. Descriptions are one
 * sentence on purpose; anything longer is documentation and belongs in the Handbook or a tooltip.
 */
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-6", className)}>
      <div className="min-w-0">
        <h1 className="flex items-center gap-2.5 text-2xl font-light tracking-tight leading-tight">
          {Icon && <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <span className="truncate">{title}</span>
        </h1>
        {description && (
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  );
}
