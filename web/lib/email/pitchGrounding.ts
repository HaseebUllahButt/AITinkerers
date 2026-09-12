// Grounding for a pitch rewrite: who the pitch actually reaches and which article it is about.
// Extracted from the single-pitch revise route so the workflow-wide apply grounds every rewrite
// the same way — each pitch against ITS recipient and ITS article, not the one the person was
// looking at when they clicked "apply to all".
//
// Best-effort by design: a failed lookup degrades to a less-grounded rewrite, never a failed
// request — a person is waiting on the single path, and on the batch path one prospect's missing
// rows should not sink the other seventy-nine.
import { supabaseAdmin } from "@/lib/db/supabase";
import { clipArticleText, OPENER_TEXT_BUDGET } from "@/lib/backlinks/articleContext";
import type { PitchReviseInput } from "@/lib/email/pitchRevise";

export async function loadPitchGrounding(email: {
  id: string;
  author_id: string;
  workflow_id: string;
}): Promise<PitchReviseInput["context"]> {
  const context: PitchReviseInput["context"] = {};
  try {
    const [{ data: author }, { data: contact }, { data: prospect }] = await Promise.all([
      supabaseAdmin.from("authors").select("full_name").eq("id", email.author_id).maybeSingle(),
      supabaseAdmin.from("contacts").select("owner_name, owner_position").eq("author_id", email.author_id).eq("type", "mailto").not("owner_name", "is", null).limit(1).maybeSingle(),
      supabaseAdmin.from("backlink_prospects").select("prospect_url, domain").eq("outreach_email_id", email.id).limit(1).maybeSingle(),
    ]);
    // Same rule as the drafter: greet whoever the address actually belongs to, else the byline.
    context.recipientName = (contact as any)?.owner_name ?? (author as any)?.full_name ?? null;
    context.recipientPosition = (contact as any)?.owner_position ?? null;
    if (prospect) {
      context.articleUrl = (prospect as any).prospect_url ?? null;
      context.domain = (prospect as any).domain ?? null;
      if (context.articleUrl) {
        const { data: article } = await supabaseAdmin.from("articles").select("title, excerpt, readability_text_excerpt").eq("url_canonical", context.articleUrl).maybeSingle();
        context.articleTitle = (article as any)?.title ?? null;
        // The extracted article text (stored at discovery / drafter backfill) rides along so a
        // rewrite can cite what the piece actually says, not just reshuffle the draft's words.
        context.articleExcerpt = clipArticleText((article as any)?.readability_text_excerpt || (article as any)?.excerpt, OPENER_TEXT_BUDGET) || null;
      }
      const { data: bl } = await supabaseAdmin.from("backlink_campaigns").select("target_url").eq("workflow_id", email.workflow_id).limit(1).maybeSingle();
      context.targetUrl = (bl as any)?.target_url ?? null;
    }
  } catch { /* grounding is optional; the rewrite still runs on the text itself */ }
  return context;
}
