"use client";

// SearchOps Agent — one image, in a box whose height is known before the bytes are.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §8.2.
//
// This file exists because of D4: SearchOps's agent generates images through the generate_assets tool
// and neither of the old chat surfaces ever displayed them.
//
// Four things a bare <img> does not do, all of them required here:
//   1. `aspectRatio` from the element's REAL width/height, never a hardcoded 16:9.
//   2. The box renders at `status: 'pending'`. The transcript reaches its final height the instant
//      generation STARTS, so bytes landing mid-stream cannot shove the messages above them.
//   3. A real onError card. Every asset URL here is a provider CDN link and those expire; with no
//      handler the user gets the browser's broken-image glyph inside a coloured box.
//   4. A fade on decode (IMAGE_FADE_MS). Instant pop-in from a solid placeholder reads as a glitch.

import { memo, useCallback, useState } from "react";
import { ImageOffIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { IMAGE_FADE_MS } from "../constants";
import type { AgentElement } from "../types";

export interface ImageElementProps {
  element: AgentElement;
  /**
   * True when this image belongs to the turn that is streaming right now. A live image decodes
   * eagerly (it is almost certainly on screen and the user is waiting for it); a replayed one from
   * a rehydrated transcript is lazy so opening a long session does not fire fifty decodes at once.
   */
  isLiveTurn?: boolean;
  /** Provided by ImageGrid. Absent ⇒ the box is inert (no lightbox, no button semantics). */
  onOpen?: (id: string) => void;
  /**
   * Fill the parent box instead of reserving one. Set by the quilted grid, whose `gridAutoRows`
   * already reserves a square cell — a second aspect-ratio box inside it would fight the cell.
   */
  fill?: boolean;
  className?: string;
}

function ImageElementImpl({ element, isLiveTurn = false, onOpen, fill = false, className }: ImageElementProps) {
  // Load/error state is keyed BY URL, not a bare boolean. An element is upserted (merge-not-replace)
  // and a re-emit can swap `url` — e.g. a pending placeholder resolving, or a refreshed signed link.
  // A bare `failed` boolean would stick to the new URL and render the error card over a good image.
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // Bumped by Retry. Used only as the <img> key so React remounts the node and the browser re-issues
  // the request. We deliberately do NOT append a cache-busting query param: these are presigned URLs
  // whose signature covers the query string, so `?retry=1` turns a recoverable blip into a hard 403.
  const [attempt, setAttempt] = useState(0);

  const url = element.url;
  const loaded = !!url && loadedUrl === url;
  const failed = element.status === "error" || (!!url && failedUrl === url);
  // Show the pulse until there are pixels: either the server has not produced the asset yet, or it
  // has and the browser is still fetching/decoding it.
  const showPlaceholder = !loaded && !failed;

  const handleLoad = useCallback(() => setLoadedUrl(url ?? null), [url]);
  const handleError = useCallback(() => setFailedUrl(url ?? null), [url]);

  /**
   * The cached-image guard. A URL already in the HTTP cache can finish loading between React
   * creating the element and attaching `onLoad` — the event never fires and the image is stuck at
   * opacity-0 forever, which looks exactly like the bug this component exists to fix. `complete` is
   * the only reliable way to catch that; `naturalWidth === 0` on a complete image means it failed.
   */
  const imgRef = useCallback(
    (node: HTMLImageElement | null) => {
      if (!node?.complete || !url) return;
      if (node.naturalWidth > 0) setLoadedUrl(url);
      else setFailedUrl(url);
    },
    [url],
  );
  const handleRetry = useCallback(() => {
    setFailedUrl(null);
    setAttempt((n) => n + 1);
  }, []);

  // No dimensions ⇒ assume square. A wrong-but-stable guess still beats an unreserved box: the
  // layout settles once, at mount, instead of jumping when the bytes land.
  const ratio = element.width && element.height ? element.width / element.height : 1;

  const box = (
    <>
      {showPlaceholder && (
        <div
          className="absolute inset-0 animate-pulse bg-muted"
          role="img"
          aria-label={element.status === "pending" ? `Generating image: ${element.name}` : `Loading image: ${element.name}`}
        />
      )}

      {url && !failed && (
        // next/image cannot express the reserved-box + onError + fade contract above (§8.2) and
        // would re-proxy CDN URLs the provider already sized. A plain <img> is the spec'd element.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={attempt}
          ref={imgRef}
          src={url}
          alt={element.name}
          width={element.width}
          height={element.height}
          loading={isLiveTurn ? "eager" : "lazy"}
          decoding="async"
          draggable={false}
          onLoad={handleLoad}
          onError={handleError}
          className={cn("h-full w-full object-cover transition-opacity", loaded ? "opacity-100" : "opacity-0")}
          style={{ transitionDuration: `${IMAGE_FADE_MS}ms` }}
        />
      )}

      {failed && <BrokenAssetCard name={element.name} url={url} onRetry={url ? handleRetry : undefined} />}
    </>
  );

  const boxClassName = cn(
    "relative overflow-hidden rounded-lg bg-muted ring-1 ring-border/60",
    fill ? "h-full w-full" : "w-full",
    className,
  );
  const boxStyle = fill ? undefined : { aspectRatio: String(ratio) };

  // Interactive only when there is something to enlarge. Never when failed — the error card owns a
  // Retry <button>, and a button inside a button is invalid HTML that Safari renders unclickable.
  if (onOpen && url && !failed) {
    return (
      <button
        type="button"
        onClick={() => onOpen(element.id)}
        aria-label={`Open image: ${element.name}`}
        className={cn(
          boxClassName,
          "block cursor-zoom-in text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
        style={boxStyle}
      >
        {box}
      </button>
    );
  }

  return (
    <div className={boxClassName} style={boxStyle}>
      {box}
    </div>
  );
}

/**
 * Shown in place of the image when the fetch fails. Absolutely positioned INSIDE the reserved box,
 * so a dead asset occupies exactly the space the live one would have — the transcript does not
 * reflow when a URL expires.
 */
function BrokenAssetCard({ name, url, onRetry }: { name: string; url?: string; onRetry?: () => void }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted p-3 text-center">
      <ImageOffIcon className="size-5 text-muted-foreground" aria-hidden />
      <p className="line-clamp-2 max-w-full text-xs text-muted-foreground" title={name}>
        {name}
      </p>
      <p className="text-xs text-muted-foreground/70">Image unavailable — the link may have expired.</p>
      <div className="flex items-center gap-1.5">
        {onRetry && (
          <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
            <RefreshCwIcon aria-hidden />
            Retry
          </Button>
        )}
        {url && (
          <Button variant="ghost" size="xs" render={<a href={url} target="_blank" rel="noreferrer noopener" />}>
            Open
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Memoized on the element reference. `useElementsFor` hands back a reference-stable bucket and the
 * store bails on no-op upserts, so an unrelated token or a re-emit that changes nothing costs zero
 * renders here — and, critically, never remounts the <img> to re-trigger its load.
 */
export const ImageElement = memo(ImageElementImpl);
ImageElement.displayName = "ImageElement";
