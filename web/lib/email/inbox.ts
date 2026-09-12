// Per-person inbox: read the full email conversation between one of our sending mailboxes and
// a specific recipient, over IMAP (read-only). Reuses the same classification the reply
// detector uses so bounces/auto-replies are labeled consistently. Also a small LLM sentiment
// helper for genuine replies.
import { ImapFlow } from "imapflow";
import { classify, findTextPart, type ReplyKind } from "@/lib/email/imap";
import { llmChat, llmEnabled } from "@/lib/providers/llm";

export interface ConversationMessage {
  uid: number;
  direction: "outbound" | "inbound"; // from us → them, or them → us
  from: string;
  fromName: string;
  to: string;
  subject: string;
  date: string;        // ISO
  body: string;        // plain-text (HTML stripped), capped
  kind: ReplyKind | null; // reply | bounce | auto for inbound; null for outbound
  messageId: string | null;
  hasAttachments: boolean;
  images: string[];       // displayable image URLs (remote <img> + inline image attachments as data URLs)
  attachments: { filename: string; contentType: string }[];
}

const norm = (s: string) => s.replace(/[<>]/g, "").trim().toLowerCase();

function clean(raw: string, isHtml: boolean, maxLen = 6000): string {
  let t = raw;
  if (isHtml || /<[a-z][\s\S]*>/i.test(t)) t = t.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
  return t.replace(/\r/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&rsquo;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxLen);
}

async function bodyText(client: ImapFlow, uid: number, structure: any): Promise<string> {
  const tp = findTextPart(structure);
  try {
    const dl = await client.download(uid, tp?.part || "1", { uid: true });
    if (!dl?.content) return "";
    const bufs: Buffer[] = [];
    for await (const c of dl.content as AsyncIterable<Buffer>) { bufs.push(c); if (Buffer.concat(bufs).length > 120_000) break; }
    return clean(Buffer.concat(bufs).toString("utf8"), !!tp?.html);
  } catch { return ""; }
}

function hasAttach(node: any): boolean {
  if (!node) return false;
  const disp = (node.disposition || "").toLowerCase();
  if (disp === "attachment") return true;
  const type = (node.type || "").toLowerCase();
  if (type && !type.startsWith("text/") && !type.startsWith("multipart/") && node.part) return true;
  return (node.childNodes || []).some(hasAttach);
}

// The text/html part id (for pulling out remote <img> URLs).
function findHtmlPart(node: any): string | undefined {
  if (!node) return undefined;
  if ((node.type || "").toLowerCase() === "text/html" && node.part) return node.part;
  for (const c of node.childNodes || []) { const r = findHtmlPart(c); if (r) return r; }
  return undefined;
}
// All non-text leaf parts (attachments + inline images), with size from bodyStructure.
function collectParts(node: any, acc: { part: string; contentType: string; filename: string; size: number }[] = []): typeof acc {
  if (!node) return acc;
  const type = (node.type || "").toLowerCase();
  if (node.part && !type.startsWith("multipart/") && !type.startsWith("text/")) {
    acc.push({ part: node.part, contentType: type, filename: node.dispositionParameters?.filename || node.parameters?.name || node.part, size: node.size || 0 });
  }
  for (const c of node.childNodes || []) collectParts(c, acc);
  return acc;
}
function extractImgUrls(html: string): string[] {
  const urls: string[] = []; const re = /<img[^>]+src=["']?(https?:\/\/[^"'\s>]+)/gi; let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && urls.length < 8) urls.push(m[1]);
  return [...new Set(urls)];
}
async function downloadPart(client: ImapFlow, uid: number, part: string): Promise<Buffer | null> {
  try {
    const dl = await client.download(uid, part, { uid: true });
    if (!dl?.content) return null;
    const bufs: Buffer[] = [];
    for await (const c of dl.content as AsyncIterable<Buffer>) bufs.push(c);
    return Buffer.concat(bufs);
  } catch { return null; }
}

// Read the whole conversation with `recipient` from `account`'s mailbox. Searches Gmail's
// "All Mail" (both sent + received in one place); falls back to INBOX.
export async function fetchConversation(account: string, pass: string, recipient: string, opts: { days?: number; max?: number } = {}): Promise<ConversationMessage[]> {
  const days = opts.days ?? 365;
  const max = opts.max ?? 60;
  const since = new Date(Date.now() - days * 86400_000);
  const rcpt = recipient.toLowerCase();
  const acct = account.toLowerCase();

  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: account, pass }, logger: false, socketTimeout: 60_000, greetingTimeout: 20_000 });
  // imapflow emits 'error' on socket issues; without a handler an emitted error crashes the
  // whole process. Swallow it here — the awaited operations reject and we handle that below.
  client.on("error", () => {});
  await client.connect();
  const out: ConversationMessage[] = [];
  try {
    let mailbox = "[Gmail]/All Mail";
    let lock;
    try { lock = await client.getMailboxLock(mailbox); }
    catch { mailbox = "INBOX"; lock = await client.getMailboxLock(mailbox); }
    try {
      // Messages to OR from this person.
      let uids = (await client.search({ since, or: [{ from: recipient }, { to: recipient }] }, { uid: true })) || [];
      if (uids.length === 0) return out;
      if (uids.length > max) uids = uids.slice(-max);

      // PASS 1: collect metadata only. Do NOT download bodies inside the fetch stream —
      // issuing a download() command mid-fetch on the same connection deadlocks → socket
      // timeout. Gather everything first, then download bodies afterward.
      const metas: { uid: number; direction: "outbound" | "inbound"; from: string; fromName: string; to: string; subject: string; date: string; kind: ReplyKind | null; messageId: string | null; structure: any; hasAttachments: boolean }[] = [];
      for await (const msg of client.fetch(uids, { uid: true, envelope: true, bodyStructure: true, headers: ["message-id", "in-reply-to", "references", "from", "auto-submitted", "x-autoreply", "precedence", "content-type", "x-failed-recipients"] }, { uid: true })) {
        const fromAddr = (msg.envelope?.from?.[0]?.address ?? "").toLowerCase();
        const toAddrs = (msg.envelope?.to ?? []).map((t: any) => (t.address ?? "").toLowerCase());
        const involvesRcpt = fromAddr === rcpt || toAddrs.includes(rcpt);
        if (!involvesRcpt) continue;
        const direction: "outbound" | "inbound" = fromAddr === acct ? "outbound" : "inbound";
        const hlow = (msg.headers?.toString() ?? "").toLowerCase();
        const subject = msg.envelope?.subject ?? "";
        metas.push({
          uid: msg.uid!, direction, from: fromAddr, fromName: msg.envelope?.from?.[0]?.name ?? "",
          to: toAddrs[0] ?? "", subject,
          date: (msg.envelope?.date ? new Date(msg.envelope.date) : new Date()).toISOString(),
          kind: direction === "inbound" ? classify(fromAddr, subject, hlow) : null,
          messageId: msg.envelope?.messageId ? norm(msg.envelope.messageId) : null,
          structure: (msg as any).bodyStructure, hasAttachments: hasAttach((msg as any).bodyStructure),
        });
      }
      // PASS 2: download bodies + images now that the fetch stream is fully drained. Bounded:
      // rich content (html images + inline image attachments) only for the most recent messages,
      // with a global cap on inline-image downloads, so a big thread can't stall the connection.
      const RICH_FROM = Math.max(0, metas.length - 14);
      let imgBudget = 12;
      for (let i = 0; i < metas.length; i++) {
        const m = metas[i];
        const body = await bodyText(client, m.uid, m.structure);
        const images: string[] = [];
        const attachments: { filename: string; contentType: string }[] = [];
        if (i >= RICH_FROM) {
          const htmlPart = findHtmlPart(m.structure);
          if (htmlPart) { const raw = await downloadPart(client, m.uid, htmlPart); if (raw) images.push(...extractImgUrls(raw.toString("utf8"))); }
          for (const p of collectParts(m.structure)) {
            attachments.push({ filename: p.filename, contentType: p.contentType });
            if (imgBudget > 0 && p.contentType.startsWith("image/") && p.size > 0 && p.size < 2_500_000) {
              const buf = await downloadPart(client, m.uid, p.part);
              if (buf) { images.push(`data:${p.contentType};base64,${buf.toString("base64")}`); imgBudget--; }
            }
          }
        }
        out.push({ uid: m.uid, direction: m.direction, from: m.from, fromName: m.fromName, to: m.to, subject: m.subject, date: m.date, kind: m.kind, messageId: m.messageId, hasAttachments: m.hasAttachments, body, images: [...new Set(images)].slice(0, 12), attachments });
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    try { await client.close(); } catch { /* ignore */ }
    throw e;
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// Reply intent — the NEXT ACTION a genuine reply implies, so the inbox can triage real-deal
// replies (interested / asking price) apart from soft or negative ones. Complements sentiment
// (tone). Best-effort (LLM); returns null when the model is unavailable or unsure.
export type ReplyIntent =
  | "interested"       // wants to cover us / work together / yes, let's do it
  | "asks_price"       // asks about cost, fee, rate, sponsored/paid pricing
  | "wants_topic"      // open, but wants a specific angle/topic/samples/more info first
  | "not_interested"   // hard no / decline / unsubscribe / not a fit
  | "follow_up_later"  // not now — reach out again later
  | "other";           // anything else / unclear

const REPLY_INTENTS: ReplyIntent[] = [
  "interested", "asks_price", "wants_topic", "not_interested", "follow_up_later", "other",
];

export async function classifyReplyIntent(text: string): Promise<ReplyIntent | null> {
  const t = (text || "").trim().slice(0, 1800);
  if (!llmEnabled() || !t) return null;
  // No `temperature`, no `maxTokens`, no `timeoutMs`: all three were Haiku-shaped and are now
  // traps on an Opus-class default. temperature:0 is a 400 on the frontier models (and a 400 here
  // reads as "no opinion" → the caller silently loses triage). max_tokens:6 bounded thinking as
  // well as the answer, so the label would come back empty. 15s aborts a turn that thinks first.
  const res = await llmChat({
    prompt: `A journalist/blogger/site owner replied to a PR/backlink outreach email. Classify what their reply wants next, as exactly one of these labels:\n\ninterested — they want to cover us, link to us, or work together; a clear yes or strong lean-in.\nasks_price — they ask about cost, fees, rates, or sponsored/paid placement pricing.\nwants_topic — open to it but want a specific angle, topic, samples, or more info before deciding.\nnot_interested — a decline, "no thanks", unsubscribe, or "not a fit".\nfollow_up_later — not right now; asks us to reach back out at a later time.\nother — anything else, or unclear.\n\nReply:\n"""${t}"""\n\nOne label only:`,
  });
  if (!res) return null;
  const w = (res.content ?? "").toLowerCase().trim();
  // Exact match wins. Otherwise take the LONGEST label that appears as a substring, so
  // "not_interested" is matched before its own substring "interested" (a hard no must never
  // be read as interest).
  if ((REPLY_INTENTS as string[]).includes(w)) return w as ReplyIntent;
  for (const intent of [...REPLY_INTENTS].sort((a, b) => b.length - a.length)) {
    if (w.includes(intent)) return intent;
  }
  // Tolerate hyphen/space variants the model might emit.
  if (/not\s*interested|no\s*thanks|unsubscribe/.test(w)) return "not_interested";
  if (/price|cost|fee|rate|paid|sponsor/.test(w)) return "asks_price";
  if (/topic|angle|sample|more info/.test(w)) return "wants_topic";
  if (/later|follow/.test(w)) return "follow_up_later";
  if (/interested|yes/.test(w)) return "interested";
  return null;
}

// Quick sentiment for a genuine reply — positive / neutral / negative. Best-effort (LLM).
export async function analyzeSentiment(text: string): Promise<"positive" | "neutral" | "negative" | null> {
  const t = (text || "").trim().slice(0, 1500);
  if (!llmEnabled() || !t) return null;
  // Same three Haiku-era settings dropped as in classifyReplyIntent above — temperature:0 is a
  // 400 on the frontier models, max_tokens:4 left no room for thinking before the one word, and
  // a 15s abort is indistinguishable from "the model declined". All three degrade to null here.
  const res = await llmChat({
    prompt: `A journalist/blogger replied to a PR outreach email. Classify the reply's sentiment toward working with us as exactly one word: positive, neutral, or negative.\n\npositive = interested, wants to cover us, asks for more, says yes.\nnegative = not interested, unsubscribe, annoyed, hard no.\nneutral = anything else (out of scope, "maybe later", clarifying question).\n\nReply:\n"""${t}"""\n\nOne word only:`,
  });
  if (!res) return null;
  const w = (res.content ?? "").toLowerCase();
  if (w.includes("positive")) return "positive";
  if (w.includes("negative")) return "negative";
  if (w.includes("neutral")) return "neutral";
  return null;
}
