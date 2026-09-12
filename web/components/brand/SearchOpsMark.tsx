/**
 * The SearchOps mark — twin peaks.
 *
 * Vector rather than an image file: it has to sit at 16px in a browser tab and at 32px in the sidebar
 * without a second asset, and a transparent background is guaranteed by construction rather than by
 * knocking one out of a raster.
 *
 * The fills come from `--mark-front` / `--mark-back`, so the mark is teal on the pale canvas and
 * teal on charcoal. That is not decoration: the teal pair had almost no weight against a light glass
 * pane and read as a watermark rather than a logo.
 *
 * Geometry note: all four slopes share the same angle (run/rise ~0.595), and the thin diagonal between
 * the two peaks is genuine transparency, not a drawn stroke — so the mark is correct on glass, on the
 * wash, and on a browser tab of any colour.
 *
 * `src/app/icon.svg` is the favicon Next serves by file convention. It carries the same geometry but
 * switches on `prefers-color-scheme` instead, since a static file cannot see the in-app theme.
 */
export function SearchOpsMark({ className }: { className?: string }) {
  return (
    <svg viewBox="14 14 72 72" className={className} role="img" aria-label="SearchOps">
      {/* Back peak first, so the front peak overlaps it. */}
      <path d="M53.6 24.8 L84 75.3 L60.2 75.3 L42 45 Z" fill="var(--mark-back)" />
      <path d="M36.4 41.4 L56.5 75.3 L16.4 75.3 Z" fill="var(--mark-front)" />
    </svg>
  );
}
