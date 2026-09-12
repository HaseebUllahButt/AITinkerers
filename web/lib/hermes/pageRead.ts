// Plain-fetch page reading: browse_page's in-app fallback for when the stealth-browser sidecar is
// not configured or fails (Vercel cannot run a browser, so this is the only self-contained option).
// Same result contract as hermesScrape so the tool can hand either to the model unchanged. All the
// extraction is existing machinery: the enrichment cascade's page-signals scan for email/contact,
// the harvesters' byline extractor, the pipeline's readability pass.
import { fetchRaw } from "@/lib/indexing/fetchRendered";
import { extractByline } from "@/lib/backlinks/authorName";
import { extractReadability } from "@/lib/extract/readability";
import { scrapePageSignals } from "@/lib/enrich/pageSignals";
import type { HermesScrapeResult } from "@/lib/hermes/client";

export async function plainPageRead(
  url: string,
  want: "email" | "byline" | "contact" | "text",
): Promise<HermesScrapeResult> {
  if (want === "email" || want === "contact") {
    const sig = await scrapePageSignals(url);
    if (!sig) {
      return { ok: false, value: null, error: "could not fetch the page — a bot-walled page needs the browser service" };
    }
    if (want === "email") {
      const email = sig.emails[0] ?? null;
      return { ok: !!email, value: email, ...(email ? {} : { error: "no email visible to a plain fetch" }) };
    }
    const contact = [
      ...sig.emails.map((e) => `mailto:${e}`),
      sig.linkedin, sig.twitter, sig.instagram, sig.mastodon, sig.personalSite,
    ].filter(Boolean).join(" | ");
    return { ok: !!contact, value: contact || null, ...(contact ? {} : { error: "no contact signals visible to a plain fetch" }) };
  }

  const page = await fetchRaw(url);
  if (!page?.ok || !page.html) {
    return {
      ok: false, value: null, status: page?.status,
      error: `could not read the page (${page ? `status ${page.status}` : "network error"}) — a bot-walled page needs the browser service`,
    };
  }
  if (want === "byline") {
    const byline = extractByline(page.html);
    return { ok: !!byline, value: byline, status: page.status, ...(byline ? {} : { error: "no byline found by a plain fetch" }) };
  }
  const readable = await extractReadability(page.html, url).catch(() => null);
  const text = (readable?.textContent ?? page.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).slice(0, 40_000);
  return { ok: true, value: null, text, status: page.status };
}
