import { NextRequest, NextResponse, after } from "next/server";
import { getWorkflow, getWorkflowProspects, getEmailTemplate, upsertLinkedinMessage, getContactedAuthorIds } from "@/lib/db/queries";
import { startGen, bumpGen, finishGen, isGenRunning } from "@/lib/email/genBuffer";
import { firstNameOf, fillTokens } from "@/lib/email/personalize";
// The generator itself lives in the lib so the backlink funnel drafts the same notes.
import { generateNote, clampNote } from "@/lib/email/linkedinNote";

export const maxDuration = 300;

// Detached generation loop (survives tab close), keyed `${id}:linkedin` so it runs
// independently of the email generator. Overwrites each included prospect's note.
async function runGeneration(workflowId: string, templateId?: string) {
  const key = `${workflowId}:linkedin`;
  const template = templateId ? await getEmailTemplate(templateId) : null;
  const { prospects } = await getWorkflowProspects(workflowId, { limit: 500 });
  const contactedElsewhere = await getContactedAuthorIds(workflowId);
  const included = prospects.filter((p) => p.included && !contactedElsewhere.has(p.author_id));

  const CONCURRENCY = 5;
  for (let i = 0; i < included.length; i += CONCURRENCY) {
    const batch = included.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (p) => {
      const author = p.author!;
      const pubName = p.domain?.name ?? p.domain?.host ?? "your work";
      try {
        const note = await generateNote(author.full_name, pubName, p.articles ?? [], template?.guidance);
        // If a LinkedIn template is chosen, its body wraps the generated note via {{custom_line}};
        // otherwise the note IS the message.
        let body = note;
        if (template?.body) {
          const vars: Record<string, string> = {
            author_name: author.full_name, first_name: firstNameOf(author.full_name), pub_name: pubName, website_name: pubName, custom_line: note,
          };
          body = clampNote(fillTokens(template.body, vars));
        }
        await upsertLinkedinMessage({ workflow_id: workflowId, author_id: p.author_id, template_id: templateId ?? null, body });
        await bumpGen(key);
      } catch (e: any) {
        await bumpGen(key, `${author.full_name}: ${e.message}`);
      }
    }));
  }
  await finishGen(key);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { template_id } = await req.json().catch(() => ({}));
  const key = `${id}:linkedin`;

  const workflow = await getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  if (await isGenRunning(key)) return NextResponse.json({ started: false, alreadyRunning: true });

  const { prospects } = await getWorkflowProspects(id, { limit: 500 });
  const contactedElsewhere = await getContactedAuthorIds(id);
  const total = prospects.filter((p) => p.included && !contactedElsewhere.has(p.author_id)).length;
  if (total === 0) return NextResponse.json({ started: false, total: 0, reason: "No new prospects to generate (already contacted or none selected)." });

  await startGen(key, total);
  after(async () => { try { await runGeneration(id, template_id); } catch { await finishGen(key); } });

  return NextResponse.json({ started: true, total });
}
