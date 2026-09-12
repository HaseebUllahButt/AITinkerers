// Active per-author recheck for the notifications feature — periodically re-fetches a
// watched author's known page directly and profiles any genuinely new articles by them,
// reusing the exact same extraction/relevance/archetype/safety/scoring path as normal
// discovery (via the shared processHit).
//
// "New" is existence-based, not date-based: we keep every article we've ever discovered
// for an author (not just their latest), and a candidate URL counts as new only if it
// isn't already anywhere in that full history — never re-processed, never re-notified.
import { fetchPage } from "@/lib/extract/fetch";
import { extractSameDomainLinks } from "@/lib/extract/mentions";
import { getSeeds, getWatchersOf, insertWatchNotification, touchWatchLastChecked,
  getUserEmailConfig, getUserAppPasswordEnc } from "@/lib/db/queries";
import { processHit } from "@/lib/pipeline/run";
import { sendEmail, sendEmailAs } from "@/lib/email/smtp";
import { decryptSecret } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/db/supabase";

const MAX_CANDIDATES_PER_AUTHOR = 20;

export interface WatchedAuthor {
  id: string;
  full_name: string;
  contacts?: { type: string; value: string }[];
}

export interface NewArticleFound {
  articleId: string;
  url: string;
  title: string | null;
  publishedAt: string | null;
}

// Checks one author for content we haven't seen yet. Returns [] if they have no known
// page to check (author_page contact), or nothing new was found.
export async function checkAuthorForNewContent(author: WatchedAuthor): Promise<NewArticleFound[]> {
  const authorPage = author.contacts?.find((c) => c.type === "author_page")?.value;
  if (!authorPage) return [];

  const fetched = await fetchPage(authorPage);
  if (!fetched) return [];

  const candidates = extractSameDomainLinks(fetched.html, fetched.finalUrl, MAX_CANDIDATES_PER_AUTHOR);
  if (candidates.length === 0) return [];

  // Drop anything we already have in the articles table (their FULL history, not just
  // their latest) before spending an LLM call on it.
  const { data: existing } = await supabaseAdmin.from("articles").select("url_canonical").in("url_canonical", candidates);
  const known = new Set((existing ?? []).map((r) => r.url_canonical));
  const fresh = candidates.filter((u) => !known.has(u));
  if (fresh.length === 0) return [];

  const seeds = await getSeeds();
  const found: NewArticleFound[] = [];

  for (const url of fresh) {
    const authorId = await processHit(`watch:${author.id}`, url, "watch", seeds).catch(() => undefined);
    // Only count it if the article really is by the author we're watching — a multi-author
    // site's page can list other people's bylines too.
    if (authorId !== author.id) continue;
    const { data: art } = await supabaseAdmin.from("articles").select("id, title, published_at").eq("url_canonical", url).maybeSingle();
    if (art) found.push({ articleId: art.id, url, title: art.title ?? null, publishedAt: art.published_at ?? null });
  }

  return found;
}

export interface SenderInfo { pass: string | null; fromName?: string }

// Shared by both the daily batch check and the per-author "Test watcher" button: runs the
// recheck, records + emails a notification to every current watcher for anything new, and
// stamps last_checked_at either way. getSenderInfo lets callers share a cache across authors.
export async function checkAndNotifyAuthor(
  author: WatchedAuthor,
  getSenderInfo: (userEmail: string) => Promise<SenderInfo>,
): Promise<{ found: NewArticleFound[]; notified: number; emailed: number }> {
  const found = await checkAuthorForNewContent(author);
  let notified = 0, emailed = 0;

  if (found.length > 0) {
    const watchers = await getWatchersOf(author.id);
    for (const article of found) {
      for (const userEmail of watchers) {
        await insertWatchNotification({ user_email: userEmail, author_id: author.id, article_id: article.articleId });
        notified++;
        const info = await getSenderInfo(userEmail);
        const subject = `New post from ${author.full_name}`;
        const body = `${author.full_name} just published something new:\n\n${article.title ?? "(untitled)"}\n${article.url}\n\nYou're getting this because you're watching ${author.full_name} in Summit.`;
        const result = info.pass
          ? await sendEmailAs({ user: userEmail, pass: info.pass, fromName: info.fromName, to: userEmail, subject, body })
          : await sendEmail({ to: userEmail, subject, body });
        if (result.ok) emailed++;
      }
    }
  }

  await touchWatchLastChecked(author.id);
  return { found, notified, emailed };
}

// Default (uncached) sender-info resolver — fine for a one-off single-author test; the
// batch check route supplies its own cached version across many authors.
export async function resolveSenderInfo(userEmail: string): Promise<SenderInfo> {
  const [enc, cfg] = await Promise.all([getUserAppPasswordEnc(userEmail), getUserEmailConfig(userEmail)]);
  return { pass: decryptSecret(enc), fromName: cfg.from_name };
}
