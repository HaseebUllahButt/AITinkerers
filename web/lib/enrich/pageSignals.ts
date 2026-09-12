import { fetchPage } from "@/lib/extract/fetch";
import { isRoleEmail, isPlaceholderEmail } from "./personFilter";

export interface PageSignals {
  emails: string[];              // non-role emails found on the page
  linkedin?: string;             // linkedin.com/in/... profile URL
  twitter?: string;              // x.com/handle
  instagram?: string;
  mastodon?: string;
  personalSite?: string;
}

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const LINKEDIN_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+/i;
const TWITTER_RE = /https?:\/\/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{2,30})/i;
const INSTAGRAM_RE = /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]{2,40})/i;
const MASTODON_RE = /@[A-Za-z0-9_]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;

const SOCIAL_JUNK = new Set(["share", "intent", "home", "explore", "login", "signup", "p", "reel", "reels", "accounts", "company", "school", "pub", "feed"]);

// Fetch a page and pull contact signals: direct emails + social profile links.
export async function scrapePageSignals(url: string): Promise<PageSignals | null> {
  const fetched = await fetchPage(url).catch(() => null);
  if (!fetched) return null;
  const html = fetched.html;

  const out: PageSignals = { emails: [] };

  // Emails — prefer mailto: links, then any address in the text; drop role inboxes.
  const seen = new Set<string>();
  const mailtos = [...html.matchAll(/mailto:([^"'>\s?]+)/gi)].map((m) => m[1]);
  const inline = html.replace(/<[^>]+>/g, " ").match(EMAIL_RE) ?? [];
  for (const raw of [...mailtos, ...inline]) {
    const e = raw.toLowerCase().trim();
    if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e)) continue;
    // The guard here used to be `e.includes("example.")` plus a couple of asset extensions. The
    // trailing dot meant it matched foo@example.com but missed `example@domain.com` and `user@domain.com`
    // outright, and eight authors ended up with a literal placeholder stored at 0.9 confidence. Because
    // `page-scrape` is the HIGHEST email-trust rank, those were cleared to send — see isPlaceholderEmail.
    if (isPlaceholderEmail(e)) continue;
    if (isRoleEmail(e)) continue;
    if (!seen.has(e)) { seen.add(e); out.emails.push(e); }
  }

  const li = html.match(LINKEDIN_RE);
  if (li) out.linkedin = li[0].replace(/\/$/, "");
  const tw = html.match(TWITTER_RE);
  if (tw && !SOCIAL_JUNK.has(tw[1].toLowerCase())) out.twitter = `https://x.com/${tw[1]}`;
  const ig = html.match(INSTAGRAM_RE);
  if (ig && !SOCIAL_JUNK.has(ig[1].toLowerCase())) out.instagram = `https://instagram.com/${ig[1]}`;
  const md = html.match(MASTODON_RE);
  if (md) out.mastodon = md[0];

  return out;
}
