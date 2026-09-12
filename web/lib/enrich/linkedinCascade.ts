import { getAuthorArticleUrls } from "@/lib/db/queries";
import { scrapePageSignals, type PageSignals } from "./pageSignals";
import { findLinkedinUrl } from "./findLinkedin";

export interface LinkedinTarget { id: string; name: string; host: string; publication: string }
export interface LinkedinResult { url: string; source: string }

const MAX_POSTS_SCAN = 50;

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

// Lighter sibling of resolveEmailCascade: hunt ONLY for the author's LinkedIn URL (no Blitz,
// no email). LinkedIn is far easier to find than an email, so storing it broadly is the
// high-hit-rate first pass — the email finder can later turn it into an email via Blitz.
// Order: scan their posts → their socials → web search by name + publication.
export async function resolveLinkedinCascade(
  t: LinkedinTarget,
  ctx: { onStep: (detail: string) => void; onIssue?: (detail: string) => void },
): Promise<LinkedinResult | null> {
  const { onStep } = ctx;
  const socials: PageSignals = { emails: [] };
  const absorb = (sig: PageSignals | null) => {
    if (!sig) return;
    socials.linkedin ??= sig.linkedin;
    socials.twitter ??= sig.twitter;
    socials.instagram ??= sig.instagram;
    socials.personalSite ??= sig.personalSite;
  };

  // 1) Scan their posts for a LinkedIn link.
  const urls = await getAuthorArticleUrls(t.id, MAX_POSTS_SCAN).catch(() => []);
  if (urls.length) {
    onStep(`scanning ${urls.length} post${urls.length === 1 ? "" : "s"} for LinkedIn…`);
    for (let i = 0; i < urls.length; i++) {
      onStep(`↳ post ${i + 1}/${urls.length}: ${hostOf(urls[i])}`);
      const sig = await scrapePageSignals(urls[i]);
      absorb(sig);
      if (socials.linkedin) { onStep(`found LinkedIn on a post`); return { url: socials.linkedin, source: "post" }; }
    }
  }

  // 2) Their other socials sometimes cross-link LinkedIn.
  for (const [label, surl] of [["X", socials.twitter], ["Instagram", socials.instagram], ["site", socials.personalSite]] as const) {
    if (!surl || socials.linkedin) continue;
    onStep(`checking ${label} profile for LinkedIn…`);
    const sig = await scrapePageSignals(surl);
    absorb(sig);
    if (socials.linkedin) { onStep(`found LinkedIn on ${label}`); return { url: socials.linkedin, source: "social" }; }
  }

  // 3) Web search by name + publication (Tavily/Google/etc.).
  onStep(`searching the web for LinkedIn (${t.name} @ ${t.publication})…`);
  const found = await findLinkedinUrl(t.name, t.publication, undefined, (m) => {
    onStep(`! web search failed: ${m}`);
    ctx.onIssue?.(`web search: ${m}`);
  }).catch(() => null);
  if (found) { onStep(`found LinkedIn via web search`); return { url: found, source: "websearch" }; }

  onStep(`no LinkedIn found anywhere`);
  return null;
}
