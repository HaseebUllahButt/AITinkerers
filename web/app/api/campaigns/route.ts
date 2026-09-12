import { NextRequest, NextResponse } from "next/server";
import { getCampaigns, createCampaign } from "@/lib/db/queries";

export async function GET() {
  try {
    const campaigns = await getCampaigns();
    return NextResponse.json(campaigns);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, keywords, region, target_hits, seed_writer_name, seed_article_url, seed_domains, seed_article_urls } = body;
    const hasSeed = seed_writer_name || seed_article_url || seed_domains?.length || seed_article_urls?.length;
    if (!name || (!keywords?.length && !hasSeed)) {
      return NextResponse.json({ error: "name and at least one of keywords / sites / articles / seed writer are required" }, { status: 400 });
    }
    const campaign = await createCampaign({ name, keywords: keywords ?? [], region, target_hits, seed_writer_name, seed_article_url, seed_domains, seed_article_urls });
    return NextResponse.json(campaign, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
