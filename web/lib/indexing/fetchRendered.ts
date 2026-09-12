// Raw-vs-rendered fetch for the indexing/render-diff analysis (PRD R1, §6.1).
//
// The PRD's dominant hidden root cause is JS-gated rendering: Google (and every AI crawler)
// sees the RAW HTML on first pass; primary content that only appears after client-side JS is
// invisible. To detect that we must fetch BOTH:
//   • raw     — a plain HTTP GET, NO JavaScript (what a non-rendering crawler sees)
//   • rendered — headless Chromium after JS settles (what a rendering pass sees)
//
// This is deliberately self-contained (its own leak-safe browser singleton) so the new
// feature never disturbs the existing link-audit crawler in src/lib/extract/fetch.ts.
// Rendering requires PLAYWRIGHT_ENABLED=true and an installed Chromium.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
};

export interface RawFetch {
  html: string;
  status: number;
  /** True when the URL itself responds with a 3xx (it redirects away). */
  isRedirect: boolean;
  /** Location header target when isRedirect. */
  redirectTo?: string;
  /** Lowercased response headers we care about (e.g. x-robots-tag). */
  headers: Record<string, string>;
  ok: boolean;
}

export interface RenderedFetch {
  html: string;
  finalUrl: string;
  status: number;
  ok: boolean;
}

export interface RawAndRendered {
  url: string;
  raw: RawFetch | null;
  rendered: RenderedFetch | null;
}

export function playwrightEnabled(): boolean {
  return process.env.PLAYWRIGHT_ENABLED === "true" && typeof window === "undefined";
}

// ── Raw fetch (no JS) ─────────────────────────────────────────────────────────
// redirect:"manual" so we can see whether the URL ITSELF redirects (a gate check),
// rather than silently following to the destination.
export async function fetchRaw(
  url: string,
  abortSignal?: AbortSignal,
): Promise<RawFetch | null> {
  const timeout = AbortSignal.timeout(12_000);
  const signal = abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout;
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "manual", signal });
    const status = res.status;
    const isRedirect = status >= 300 && status < 400;
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    // Only read a body for a real 2xx page; redirects/errors carry no useful HTML.
    let html = "";
    if (status >= 200 && status < 300) {
      html = await res.text();
    } else {
      await res.body?.cancel().catch(() => {});
    }
    return {
      html,
      status,
      isRedirect,
      redirectTo: isRedirect ? headers["location"] : undefined,
      headers,
      ok: status >= 200 && status < 300,
    };
  } catch {
    return null;
  }
}

// ── Shared browser singleton (leak-safe: one browser, a page per URL) ───────────
let sharedBrowser: import("playwright").Browser | null = null;
let launching: Promise<import("playwright").Browser | null> | null = null;

async function getBrowser(): Promise<import("playwright").Browser | null> {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  if (launching) return launching;
  launching = (async () => {
    try {
      const { chromium } = await import("playwright");
      sharedBrowser = await chromium.launch({ headless: true });
      sharedBrowser.on("disconnected", () => {
        sharedBrowser = null;
      });
      return sharedBrowser;
    } catch {
      return null;
    } finally {
      launching = null;
    }
  })();
  return launching;
}

export async function closeIndexingBrowser(): Promise<void> {
  const b = sharedBrowser;
  sharedBrowser = null;
  if (b) await b.close().catch(() => {});
}

// ── Rendered fetch (headless Chromium, JS executed) ─────────────────────────────
export async function fetchRendered(url: string): Promise<RenderedFetch | null> {
  if (!playwrightEnabled()) return null;
  const browser = await getBrowser();
  if (!browser) return null;

  let page: import("playwright").Page | null = null;
  try {
    page = await browser.newPage({ userAgent: UA });
    // domcontentloaded (not networkidle — that times out on sites with persistent
    // analytics/websocket connections), then a fixed settle for client hydration.
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(2500);
    const html = await page.content();
    const finalUrl = page.url();
    const status = resp?.status() ?? 200;
    return { html, finalUrl, status, ok: status >= 200 && status < 400 };
  } catch {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Fetch raw + rendered for one URL. Both run; either may be null (network/timeout/
// Playwright disabled). Callers diff the two to classify render mode.
export async function fetchRawAndRendered(
  url: string,
  abortSignal?: AbortSignal,
): Promise<RawAndRendered> {
  const [raw, rendered] = await Promise.all([
    fetchRaw(url, abortSignal),
    fetchRendered(url),
  ]);
  return { url, raw, rendered };
}
