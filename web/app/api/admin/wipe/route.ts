import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";
import { auth } from "@auth";

export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const wipe = async (table: string) => {
    const { error } = await (supabaseAdmin.from(table as any).delete() as any).not("id", "is", null);
    if (error) console.warn(`[wipe] ${table}:`, error.message);
    return !error;
  };

  // Delete in FK dependency order
  const results: Record<string, boolean> = {};
  results.scores = await wipe("scores");
  results.mentions = await wipe("mentions");
  results.links = await wipe("links");
  results.contacts = await wipe("contacts");
  results.article_authors = await wipe("article_authors");
  results.articles = await wipe("articles");
  results.authors = await wipe("authors");
  results.domains = await wipe("domains");
  results.discovery_hits = await wipe("discovery_hits");

  return NextResponse.json({ ok: true, results });
}
