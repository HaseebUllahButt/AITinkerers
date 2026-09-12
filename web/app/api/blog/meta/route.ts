import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { listEntries, categoryType, strapiConfigured } from "@/lib/strapi/client";

export const maxDuration = 30;

async function session(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && (req.headers.get("authorization") === `Bearer ${secret}` || req.nextUrl.searchParams.get("key") === secret)) {
    return { user: { email: "cron" } };
  }
  return auth().catch(() => null);
}

// GET — authors + categories for the composer's dropdowns. Read-only, cheap to call often.
export async function GET(req: NextRequest) {
  const s = await session(req);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!strapiConfigured()) return NextResponse.json({ ok: false, error: "Strapi not configured" }, { status: 503 });
  try {
    const [authors, categories] = await Promise.all([
      listEntries("authors", { pageSize: 100, sort: "username:asc" }),
      listEntries(categoryType(), { pageSize: 100, sort: "title:asc" }),
    ]);
    return NextResponse.json({
      ok: true,
      authors: authors.data.map((a: any) => ({ id: a.id, name: a.username })),
      categories: categories.data.map((c: any) => ({ id: c.id, title: c.title, slug: c.slug })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "meta load failed" }, { status: 500 });
  }
}
