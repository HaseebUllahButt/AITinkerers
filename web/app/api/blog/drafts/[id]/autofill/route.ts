import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { getBlogDraft, listWriterVoices, getWriterVoice, getWriterSession } from "@/lib/db/queries";
import { applyDraftPatch } from "@/lib/blog/save";
import { planAutofill, type MetaInput } from "@/lib/blog/autofill";
import { loadStrapiOptions } from "@/lib/blog/autofillOptions";
import { generateMeta } from "@/lib/writer/meta";
import { writerEnabled } from "@/lib/writer/anthropic";

export const maxDuration = 60;

// POST /api/blog/drafts/:id/autofill — fill every field the user left empty, and report each one.
//
// Runs on any draft, written by the agent or typed by hand. Three inputs, in descending order of
// authority: what the human already wrote (never touched), the real options in Strapi (authors and
// categories, fetched live), and the model's reading of the finished body (title, description, SEO,
// tags). The planner in @/lib/blog/autofill decides; this route only gathers.
//
// Metadata generation is skipped, not faked, when there is no ANTHROPIC_API_KEY or no body yet — the
// no-model fills (slug from title, thumbnail from cover, indexing defaults, author, category) all
// still happen. Same for Strapi being unreachable.
//
// Writes through applyDraftPatch, so it takes a revision first and never touches Strapi. Pressing
// this is always undoable from the revisions popover.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;

  const draft = await getBlogDraft(id);
  if (!draft) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  const notes: string[] = [];

  // The voice: the one that wrote this piece if it came from the agent, else the default. It carries
  // the CTA, which must never be invented here.
  const session = draft.writer_session_id ? await getWriterSession(draft.writer_session_id).catch(() => null) : null;
  let voice = session?.voice_id ? await getWriterVoice(session.voice_id).catch(() => null) : null;
  if (!voice) voice = (await listWriterVoices().catch(() => []))
    .find((v) => v.is_default) ?? null;

  // Model metadata over the finished body. Cheap (low effort, no thinking) but pointless on an empty
  // draft, so it is gated on there being something to read.
  const body = String(draft.body ?? "");
  let meta: MetaInput | null = null;
  if (body.trim().length < 200) {
    notes.push("The body is too short to write metadata from, so only the non-writing fields were filled.");
  } else if (!writerEnabled()) {
    notes.push("ANTHROPIC_API_KEY is not set, so title, description, SEO and tags were left alone.");
  } else if (!voice) {
    notes.push("No voice profile found, so metadata generation was skipped.");
  } else {
    const brief = (session?.brief ?? {}) as Record<string, unknown>;
    const r = await generateMeta(body, voice, brief as never).catch((e) => ({
      meta: null, problems: [e?.message ?? "metadata generation failed"], usage: null,
    }));
    meta = r.meta;
    // Strapi's title ≥35 / description ≥120 minimums cannot be expressed in a JSON schema, so
    // generateMeta code-checks them. A value that failed the check is still better than an empty
    // field on a draft (nothing publishes from here), but the user should know it needs a look.
    for (const p of r.problems) notes.push(p);
  }

  // Real Strapi options. Tolerant: an unreachable CMS degrades to "author and category skipped",
  // which is exactly what the planner reports when the lists come back empty.
  const { options: strapi, notes: strapiNotes } = await loadStrapiOptions();
  notes.push(...strapiNotes);

  const plan = planAutofill({
    draft,
    meta,
    voice: voice ? { default_cta_text: voice.default_cta_text, default_cta_url: voice.default_cta_url } : null,
    strapi,
    topic: (session?.brief as any)?.primary_keyword ?? null,
  });

  if (Object.keys(plan.patch).length === 0) {
    return NextResponse.json({ ok: true, draft, filled: [], skipped: plan.skipped, notes });
  }

  const saved = await applyDraftPatch(id, plan.patch, { reason: "autofill", editedBy: s.user?.email ?? null });
  if (!saved?.ok) {
    return NextResponse.json({ ok: false, error: (saved as any)?.error ?? "save failed" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true, draft: saved.draft, filled: plan.filled, skipped: plan.skipped, notes,
  });
}
