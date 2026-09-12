import { NextRequest, NextResponse, after } from "next/server";
import { auth } from "@auth";
import { getWorkflow, getWorkflowProspects, getEmailTemplate, upsertOutreachEmail, getContactedAuthorIds } from "@/lib/db/queries";
import { startGen, bumpGen, finishGen, isGenRunning } from "@/lib/email/genBuffer";
import { llmChat } from "@/lib/providers/llm";
import { firstNameOf, fillTokens, ensurePersonalized } from "@/lib/email/personalize";

// Same gate the other routes use: a signed-in session, or the CRON_SECRET (Bearer / ?key=).
async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
    if (req.nextUrl.searchParams.get("key") === secret) return true;
  }
  return !!(await auth().catch(() => null));
}

export const maxDuration = 300;

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";

interface OpenerArticle { title?: string; archetype?: string; published_at?: string; excerpt?: string; readability_text_excerpt?: string }

function fmtDate(iso?: string): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleDateString("en-US", { month: "long", year: "numeric" }); }
  catch { return ""; }
}

// Remove em/en dashes and other "AI tells"; normalize spacing WITHOUT flattening paragraphs
// (keep single/double newlines so the email keeps its structure).
function sanitize(text: string): string {
  return text
    .replace(/\s*[—–]\s*/g, ", ")   // em/en dash → comma
    .replace(/[ \t]{2,}/g, " ")     // collapse runs of spaces/tabs only (not newlines)
    .replace(/ ,/g, ",")
    .replace(/[ \t]+\n/g, "\n")     // trim trailing spaces on each line
    .replace(/\n{3,}/g, "\n\n")     // cap blank lines at one
    .trim();
}

// Scraped page titles arrive with HTML entities, a trailing " | Site" / " - Site" suffix, and
// sometimes mid-title truncation ("... Pika &"). {{article_title}} goes straight into subject
// lines, so clean it: decode entities, drop the site suffix, trim dangling junk, cap length.
function decodeEntities(s: string): string {
  return (s ?? "")
    .replace(/&#0*39;|&#x0*27;|&apos;|&lsquo;|&rsquo;|&#8216;|&#8217;/gi, "'")
    .replace(/&quot;|&#0*34;|&ldquo;|&rdquo;|&#8220;|&#8221;/gi, '"')
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ""; } })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ""; } });
}
function cleanTitle(raw: string, maxLen = 90): string {
  let t = decodeEntities((raw ?? "").replace(/\s+/g, " ").trim());
  // Drop the site name after the last pipe: "Title | Section | Site" → "Title | Section".
  if (t.includes("|")) { const parts = t.split("|"); if (parts.length > 1) t = parts.slice(0, -1).join("|").trim(); }
  // Drop a trailing " - Site" / " — Site" when the tail is a short, site-like fragment
  // (no sentence punctuation), e.g. "... by Michelle DeLateur - ProVideo Coalition".
  t = t.replace(/\s+[–—-]\s+([^–—-]{2,38})$/, (m, tail) => (/[.?!:]/.test(tail) ? m : "")).trim();
  if (t.length > maxLen) t = t.slice(0, maxLen).replace(/\s+\S*$/, "").trim();
  // Strip dangling conjunctions/punctuation left by upstream truncation or the length cap
  // ("... Pika &", "... Millions of").
  const trimTail = (x: string) => x.replace(/[\s,:;&/+\-]+$/, "").replace(/\s+(and|or|the|a|an|with|to|of|for|in|on|by|vs\.?)$/i, "").trim();
  t = trimTail(trimTail(t));
  return t;
}

// Free-mail hosts aren't a "publication" — "your readers at gmail.com" reads wrong.
const FREE_MAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "proton.me", "protonmail.com", "aol.com", "me.com", "live.com", "msn.com"]);
function cleanPubName(pub: string): string {
  return FREE_MAIL.has((pub ?? "").toLowerCase().replace(/^www\./, "")) ? "your work" : pub;
}

// An email must NEVER ship with a literal placeholder the model invented.
function hasPlaceholder(s: string): boolean {
  return /\[[^\]]{1,40}\]/.test(s) || /\{\{[^}]+\}\}/.test(s);
}

async function generateOpener(authorName: string, pubName: string, articles: OpenerArticle[], tools: string[], guidance?: string): Promise<string> {
  const sorted = [...articles].sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  const lead = sorted[0];
  const leadTitle = cleanTitle(lead?.title ?? "");
  const leadDate = fmtDate(lead?.published_at);
  const leadTopic = (lead?.excerpt ?? lead?.readability_text_excerpt ?? "").slice(0, 300).trim();
  const toolList = tools.slice(0, 3).join(", ");
  const hasContent = !!(leadTitle || leadTopic);

  // A safe, specific-free opener used whenever we can't (or shouldn't) fabricate specifics —
  // no AI key, no real article content, or the model returned placeholder junk.
  const fallback = leadTitle
    ? `I really enjoyed your recent piece, "${leadTitle}".`
    : `I've been following your writing${pubName && pubName !== "your work" ? ` at ${pubName}` : ""} and really enjoy it.`;

  if (!OPENROUTER_KEY || !hasContent) return fallback;

  const prompt = `Write the opening 1-2 sentences of a COLD outreach email to ${authorName}, a writer at ${pubName}.

What we actually know about them:
- Article title: ${leadTitle || "(unknown)"}
${leadDate ? `- Published: ${leadDate}` : ""}
${leadTopic ? `- About: ${leadTopic}` : ""}
${toolList ? `- They cover: ${toolList}` : ""}

HARD RULES (follow ALL):
- NEVER output bracketed placeholders like [topic], [name], [specific point], [publication]. Only mention details explicitly listed above; if a detail isn't given, DON'T reference it.
- This is a first-ever cold email. Do NOT imply prior contact or use "Re:".
- NEVER use em-dashes or en-dashes (— –). Commas or periods only.
- Sound like a real person. Not salesy, not fawning. SHORT and punchy, 1-2 sentences.
- No greeting, no sign-off, plain text, no markdown.${guidance ? `\n\nSENDER'S WRITING DIRECTION (obey exactly, including any length/word limit):\n${guidance}` : ""}`;

  // Model / output budget / timeout all come from llmChat so there's one place to raise them.
  // temperature is deliberately NOT passed: the frontier models reject any sampling param with a
  // 400, which would cost us the entire opener. The old 0.7 bought phrasing variety; that's gone,
  // and the per-author variety now comes from the prompt content alone.
  // max_tokens is likewise omitted: the old 200 was sized for a Haiku one-liner, and on a
  // reasoning model that ceiling covers thinking too, so it comes back empty or half-written.
  const res = await llmChat({ prompt });
  // The old code threw on a non-2xx so the caller's catch reports the author and skips the upsert
  // (better no email than a half-generated one). llmChat collapses every failure into null, so
  // re-throw to keep that path alive — only the HTTP status is no longer visible to us.
  if (!res) throw new Error("OpenRouter request failed");
  const out = sanitize(res.content.trim());
  // Guard: if the model still slipped in a placeholder or returned nothing, use the fallback.
  return (!out || hasPlaceholder(out)) ? fallback : out;
}

// Token filling (incl. the drop-the-whole-line rule for an empty {{article_link}}) now lives in
// src/lib/email/personalize.ts, shared with the backlink drafter and the LinkedIn generator.

// Runs the actual generation loop DETACHED from the request so it survives tab close.
// Overwrites every included prospect's email (upsert on workflow_id+author_id).
async function runGeneration(workflowId: string, templateId?: string) {
  const template = templateId ? await getEmailTemplate(templateId) : null;
  const { prospects } = await getWorkflowProspects(workflowId, { limit: 500 });
  const contactedElsewhere = await getContactedAuthorIds(workflowId);
  // Only generate for included prospects NOT already contacted in another campaign.
  const included = prospects.filter((p) => p.included && !contactedElsewhere.has(p.author_id));
  // Progress already started in POST; loop just reports per-item completion.

  const CONCURRENCY = 5;
  for (let i = 0; i < included.length; i += CONCURRENCY) {
    const batch = included.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (p) => {
      const author = p.author!;
      const pubName = cleanPubName(p.domain?.name ?? p.domain?.host ?? "your work");
      const tools = (p.articles ?? [])
        .flatMap((a: any) => (a.mentions ?? []).map((m: any) => m.tool_name))
        .filter((v: string, idx: number, arr: string[]) => arr.indexOf(v) === idx)
        .slice(0, 5);

      try {
        const opener = await generateOpener(author.full_name, pubName, p.articles ?? [], tools, template?.guidance);

        const firstArticle = [...(p.articles ?? [])].sort((a: any, b: any) => (b.published_at ?? "").localeCompare(a.published_at ?? ""))[0];
        // A real, unmangled link to the article the opener references — filled as its own
        // placeholder (not glued onto the opener text) so a template author can see and
        // delete the whole "I read this at: {{article_link}}" line if they don't want a link.
        const articleLink: string = firstArticle?.url_canonical ?? "";
        const vars: Record<string, string> = {
          author_name: author.full_name,
          first_name: firstNameOf(author.full_name),
          pub_name: pubName,
          website_name: pubName, // alias for {{pub_name}} — the author's site/publication name
          article_title: cleanTitle(firstArticle?.title ?? ""),
          article_date: firstArticle?.published_at?.slice(0, 10) ?? "",
          tool_mentioned: tools[0] ?? "AI tools",
          custom_line: opener,
          article_link: articleLink,
        };

        // Fill template, drop any leftover unfilled {{tokens}}, and tidy whitespace.
        const clean = (s: string) => sanitize(fillTokens(s, vars, { dropLineFor: ["article_link"] }));
        const subject = clean(template?.subject ?? "Quick note on your recent piece");
        // The deterministic guarantee: greeting with the person's first name, and the article link
        // present — re-added if a hand-written template forgot either. Body only, never subject.
        const body = ensurePersonalized(
          clean(template?.body ?? `Hi {{first_name}},\n\n{{custom_line}}\n\nI read this at: {{article_link}}\n\nBest,\nAbdullah`),
          { firstName: firstNameOf(author.full_name), articleUrl: articleLink || null },
        );

        await upsertOutreachEmail({ workflow_id: workflowId, author_id: p.author_id, template_id: templateId ?? undefined, subject, body, status: "ready" });
        await bumpGen(workflowId);
      } catch (e: any) {
        await bumpGen(workflowId, `${author.full_name}: ${e.message}`);
      }
    }));
  }

  await finishGen(workflowId);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await authorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const { template_id } = await req.json().catch(() => ({}));

  const workflow = await getWorkflow(id);
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  if (await isGenRunning(id)) return NextResponse.json({ started: false, alreadyRunning: true });

  const { prospects } = await getWorkflowProspects(id, { limit: 500 });
  const contactedElsewhere = await getContactedAuthorIds(id);
  const total = prospects.filter((p) => p.included && !contactedElsewhere.has(p.author_id)).length;
  if (total === 0) return NextResponse.json({ started: false, total: 0, reason: "No new prospects to generate (already contacted or none selected)." });

  // Mark started BEFORE responding so the progress poll (possibly on another serverless
  // instance) sees it immediately in Redis. after() keeps the function alive to run the
  // generation post-response — the Vercel-supported way to do work after the response
  // (a bare fire-and-forget promise gets frozen once the response is sent).
  await startGen(id, total);
  after(async () => { try { await runGeneration(id, template_id); } catch { await finishGen(id); } });

  return NextResponse.json({ started: true, total });
}
