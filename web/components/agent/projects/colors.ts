// Project colours, stored as TOKEN NAMES and rendered as literal classes.
//
// Three constraints meet here, and the shape of this file is what falls out of them:
//
//  1. `hermes_projects.color` holds a token name, never a hex (migration 069). A stored hex would
//     be one value pretending to work in two themes.
//  2. --chart-1 … --chart-5 are the only palette entries defined in BOTH the light and dark blocks
//     of globals.css and registered into @theme, so they are the only five that can be a dot in
//     either theme without inventing a colour.
//  3. Tailwind v4 scans source TEXT. `bg-${token}` produces the right string at runtime and no rule
//     at build time, so the dot would render with no background at all. Hence the longhand map.
//
// This is a plain data module — no React, no "use client" — precisely so the API route can import
// it too. The validator and the renderer have to agree on the same five names, or the database can
// hold a colour the UI has no way to draw.

/** Offered in this order in the swatch row, and cycled through by `suggestProjectColor`. */
export const PROJECT_COLORS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"] as const;

export type ProjectColor = (typeof PROJECT_COLORS)[number];

/** Written out because Tailwind cannot see a template literal. See note 3 above. */
const DOT_CLASS: Record<ProjectColor, string> = {
  "chart-1": "bg-chart-1",
  "chart-2": "bg-chart-2",
  "chart-3": "bg-chart-3",
  "chart-4": "bg-chart-4",
  "chart-5": "bg-chart-5",
};

export function isProjectColor(value: unknown): value is ProjectColor {
  return typeof value === "string" && (PROJECT_COLORS as readonly string[]).includes(value);
}

/** Unknown or missing colours fall back to a muted dot rather than to nothing: a project whose
 *  colour predates a palette change should still be findable by shape, not vanish. */
export function projectDotClass(color: string | null | undefined): string {
  return isProjectColor(color) ? DOT_CLASS[color] : "bg-muted-foreground/40";
}

/** The colour offered for the next project, given how many already exist. Deterministic, so five
 *  projects made in a row are five different colours without anyone having to choose. */
export function suggestProjectColor(existingCount: number): ProjectColor {
  return PROJECT_COLORS[existingCount % PROJECT_COLORS.length];
}
