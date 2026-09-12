import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getAuthorDetail } from "@/lib/db/queries";
import { checkAndNotifyAuthor, resolveSenderInfo } from "@/lib/pipeline/watch";

async function currentEmail(): Promise<string | null> {
  const session = await auth().catch(() => null);
  return (session?.user?.email as string | undefined) ?? null;
}

// POST — manually run the same recheck the daily cron does, but for ONE author right now.
// Verbose response for the "Test watcher" button: website name, whether we actually had a
// page to check, any newly-found articles, and — regardless of outcome — the most recent
// article we currently have on file for them, so you can see exactly what "latest" means.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ authorId: string }> }) {
  const email = await currentEmail();
  if (!email) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const { authorId } = await params;
  const before = await getAuthorDetail(authorId);
  if (!before) return NextResponse.json({ error: "author not found" }, { status: 404 });

  const authorPageUrl = before.contacts.find((c: any) => c.type === "author_page")?.value ?? null;
  const website = before.domain?.name ?? before.domain?.host ?? null;

  const { found, notified, emailed } = await checkAndNotifyAuthor(
    { id: before.author.id, full_name: before.author.full_name, contacts: before.contacts },
    resolveSenderInfo,
  );

  // Re-fetch — a just-found article needs to show up as "latest" too.
  const after = found.length > 0 ? await getAuthorDetail(authorId) : before;
  const latest = after?.articles?.[0] ?? null;

  return NextResponse.json({
    website,
    checked: !!authorPageUrl,
    authorPageUrl,
    newArticlesFound: found.length,
    newArticles: found.map((f) => ({ title: f.title, url: f.url, publishedAt: f.publishedAt })),
    notified,
    emailed,
    latestArticle: latest ? { title: latest.title, url: latest.url_canonical, publishedAt: latest.published_at } : null,
  });
}
