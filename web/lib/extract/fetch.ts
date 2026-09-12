// A real Chrome UA — a bot UA gets 403'd or served stub HTML by most sites, which on Vercel
// (no headless browser) means zero extracted authors. Fetching like a browser recovers the
// large majority of SSR article/blog/news pages without needing Playwright.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export interface FetchResult {
  html: string;
  finalUrl: string;
  status: number;
  usedPlaywright: boolean;
}

function isJsRendered(html: string): boolean {
  // Heuristic: tiny body or common SPA indicators
  const bodyContent = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const textLength = bodyContent.replace(/<[^>]+>/g, "").trim().length;
  return textLength < 500;
}

export async function fetchPage(url: string, abortSignal?: AbortSignal): Promise<FetchResult | null> {
  // Combine pipeline abort signal with per-request timeout
  const timeout = AbortSignal.timeout(8_000);
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, timeout])
    : timeout;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "sec-ch-ua": '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "follow",
      signal,
    });

    if (!res.ok) {
      // Drain the body so undici releases the socket/buffers instead of holding them
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const html = await res.text();
    const finalUrl = res.url;

    if (!isJsRendered(html)) {
      return { html, finalUrl, status: res.status, usedPlaywright: false };
    }

    // Step 2: Escalate to Playwright for JS-rendered pages
    if (playwrightEnabled()) {
      return fetchWithPlaywright(url);
    }

    return { html, finalUrl, status: res.status, usedPlaywright: false };
  } catch {
    if (playwrightEnabled()) {
      return fetchWithPlaywright(url).catch(() => null);
    }
    return null;
  }
}

function playwrightEnabled(): boolean {
  return process.env.PLAYWRIGHT_ENABLED === "true" && typeof window === "undefined";
}

// ── Shared browser singleton ────────────────────────────────────────────────
// Launching a fresh chromium per page leaks browser processes (~200MB each) —
// especially when page.goto() times out and the browser is never closed.
// Instead we lazily launch ONE browser and reuse it, opening/closing a page per URL.
let sharedBrowser: import("playwright").Browser | null = null;
let browserLaunching: Promise<import("playwright").Browser | null> | null = null;

async function getBrowser(): Promise<import("playwright").Browser | null> {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  if (browserLaunching) return browserLaunching;

  browserLaunching = (async () => {
    try {
      const { chromium } = await import("playwright");
      sharedBrowser = await chromium.launch({ headless: true });
      // If the browser dies/disconnects, drop our reference so the next call relaunches
      sharedBrowser.on("disconnected", () => { sharedBrowser = null; });
      return sharedBrowser;
    } catch {
      return null;
    } finally {
      browserLaunching = null;
    }
  })();

  return browserLaunching;
}

export async function closeSharedBrowser(): Promise<void> {
  const b = sharedBrowser;
  sharedBrowser = null;
  if (b) await b.close().catch(() => {});
}

async function fetchWithPlaywright(url: string): Promise<FetchResult | null> {
  const browser = await getBrowser();
  if (!browser) return null;

  let page: import("playwright").Page | null = null;
  try {
    page = await browser.newPage({ userAgent: UA });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(1500);
    const html = await page.content();
    const finalUrl = page.url();
    return { html, finalUrl, status: 200, usedPlaywright: true };
  } catch {
    return null;
  } finally {
    // ALWAYS close the page — this is the leak fix. Even on goto timeout,
    // the page (a chromium tab holding a full render tree) is released.
    if (page) await page.close().catch(() => {});
  }
}
