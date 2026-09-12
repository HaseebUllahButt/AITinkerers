// The sample step of the Pitch angle dialog: "write ONE pitch my way and show me, before it
// touches anything".
//
// Every initial pitch is drafted from the stock paid angle (the template body and sitePitch both
// open with "we'd like to pay"), and the fix for "I want a different angle" must not be "apply it
// to eighty prospects and hope". So the dialog drafts a sample against a REAL prospect from this
// campaign first, the person reads it, and only then does the angle get saved and applied. This
// module is that sample: it writes NOTHING — same proposal contract as revisePitch itself.
//
// The sample is taken the way the apply will actually run, in preference order:
//
//   'existing' — the campaign's best-scored prospect that already has an unsent pitch, rewritten
//                from its current draft. This is literally what "apply to every prospect" does to
//                that pitch, so the sample cannot overpromise.
//   'fresh'    — no pitches exist yet, so one is assembled the way the drafter would (template +
//                fallback opener, or the site shape) and rewritten. This is what "Write pitches"
//                will produce for every prospect once the angle is saved.
//
// One model call either way. The fresh path deliberately uses openerFallback rather than the
// opener model: the person is waiting, and the angle rewrite is the thing being previewed — the
// opener's grounding still arrives via articleExcerpt, which revisePitch feeds to the model.
import { supabaseAdmin } from "@/lib/db/supabase";
import { getEmailTemplate } from "@/lib/db/queries";
import { revisePitch } from "@/lib/email/pitchRevise";
import { loadPitchGrounding } from "@/lib/email/pitchGrounding";
import { clipArticleText, openerFallback, OPENER_TEXT_BUDGET } from "./articleContext";
import { firstNameOf, fillTokens, ensurePersonalized } from "@/lib/email/personalize";
import { sitePitch, OFF_TOPIC_MARKER, type BacklinkCampaign } from "./pipeline";

export interface PitchAnglePreview {
  domain: string;
  recipient: string | null;
  subject: string;
  body: string;
  sampledFrom: "existing" | "fresh";
}

export async function previewPitchAngle(
  bl: BacklinkCampaign,
  instruction: string,
): Promise<{ ok: true; preview: PitchAnglePreview } | { ok: false; error: string }> {
  // Best first, same order the drafter and the funnel use — the sample should be the prospect the
  // person is most likely looking at, not whichever row Postgres returned first.
  const { data: prospects, error: prospectsError } = await supabaseAdmin
    .from("backlink_prospects")
    .select("id, author_id, domain, prospect_url, angle, outreach_email_id")
    .eq("backlink_campaign_id", bl.id)
    .order("score", { ascending: false, nullsFirst: false });
  if (prospectsError) return { ok: false, error: `Could not read the campaign's prospects (${prospectsError.message}).` };
  const rows = (prospects ?? []) as Array<{ id: string; author_id: string; domain: string; prospect_url: string; angle: string | null; outreach_email_id: string | null }>;
  if (!rows.length) return { ok: false, error: "No prospects in this campaign yet — find prospects first, then set the angle." };

  // ── 'existing': rewrite the best prospect's current unsent draft ────────────────────────────
  const pitchIds = rows.map((r) => r.outreach_email_id).filter(Boolean) as string[];
  if (pitchIds.length) {
    const { data: pitches, error: pitchesError } = await supabaseAdmin
      .from("outreach_emails")
      .select("id, author_id, workflow_id, subject, body, status, sent_at")
      .in("id", pitchIds)
      .is("sent_at", null)
      .neq("status", "sent");
    if (pitchesError) return { ok: false, error: `Could not read the campaign's pitches (${pitchesError.message}).` };
    type PitchRow = { id: string; author_id: string; workflow_id: string; subject: string | null; body: string | null };
    const unsent = new Map(((pitches ?? []) as PitchRow[]).filter((m) => m.body?.trim()).map((m) => [m.id, m]));
    const sample = rows.find((r) => r.outreach_email_id && unsent.has(r.outreach_email_id));
    if (sample) {
      const mail = unsent.get(sample.outreach_email_id as string)!;
      const context = await loadPitchGrounding({ id: mail.id, author_id: mail.author_id, workflow_id: mail.workflow_id });
      const out = await revisePitch({ instruction, subject: mail.subject ?? "", body: mail.body ?? "", context });
      if (!out.ok || !out.body) return { ok: false, error: out.error ?? "The sample rewrite failed." };
      return {
        ok: true,
        preview: {
          domain: sample.domain, recipient: context.recipientName ?? null,
          subject: out.subject ?? mail.subject ?? "", body: out.body, sampledFrom: "existing",
        },
      };
    }
  }

  // ── 'fresh': nothing drafted yet, so assemble one the way the drafter would, then rewrite ───
  const p = rows[0];
  const [authorRes, contactRes, articleRes] = await Promise.all([
    supabaseAdmin.from("authors").select("full_name").eq("id", p.author_id).maybeSingle(),
    supabaseAdmin.from("contacts").select("owner_name, owner_position").eq("author_id", p.author_id).eq("type", "mailto").not("owner_name", "is", null).limit(1).maybeSingle(),
    supabaseAdmin.from("articles").select("title, excerpt, readability_text_excerpt").eq("url_canonical", p.prospect_url).maybeSingle(),
  ]);
  const author = authorRes.data as { full_name: string | null } | null;
  const contact = contactRes.data as { owner_name: string | null; owner_position: string | null } | null;
  const article = articleRes.data as { title: string | null; excerpt: string | null; readability_text_excerpt: string | null } | null;
  // Same rule as the drafter: greet whoever the address actually belongs to, else the byline.
  const recipientName = contact?.owner_name ?? author?.full_name ?? "there";
  const articleText = clipArticleText(article?.readability_text_excerpt || article?.excerpt, OPENER_TEXT_BUDGET);
  const title = article?.title || null;

  // Which shape the drafter would pick: the article pitch when there is a page worth pitching,
  // the site pitch when the campaign is site-mode or the relevance gate already said no.
  const siteShape = bl.pitch_mode === "site" || !articleText || !!p.angle?.includes(OFF_TOPIC_MARKER);
  let subject: string, body: string;
  if (siteShape) {
    ({ subject, body } = sitePitch({ recipientName, domain: p.domain, targetUrl: bl.target_url }));
  } else {
    const template = bl.template_id ? await getEmailTemplate(bl.template_id) : null;
    const first = firstNameOf(recipientName);
    const vars = {
      first_name: first,
      author_name: String(recipientName),
      custom_line: openerFallback(title, !!contact?.owner_name),
      article_link: p.prospect_url,
      article_title: title ?? "",
      target_url: bl.target_url,
    };
    subject = fillTokens(template?.subject ?? "A resource for your piece", vars).trim() || "A resource for your piece";
    body = ensurePersonalized(
      fillTokens(template?.body ?? "Hi {{first_name}},\n\n{{custom_line}}\n\n{{article_link}}", vars),
      { firstName: first, articleUrl: p.prospect_url },
    );
  }

  const out = await revisePitch({
    instruction, subject, body,
    context: {
      recipientName, domain: p.domain, targetUrl: bl.target_url,
      ...(siteShape ? {} : { articleTitle: title, articleUrl: p.prospect_url, articleExcerpt: articleText || null }),
    },
  });
  if (!out.ok || !out.body) return { ok: false, error: out.error ?? "The sample rewrite failed." };
  return {
    ok: true,
    preview: { domain: p.domain, recipient: recipientName, subject: out.subject ?? subject, body: out.body, sampledFrom: "fresh" },
  };
}
