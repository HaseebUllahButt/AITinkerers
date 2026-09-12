// Chat attachments: files a person drops into Summer.
//
// ── Where the bytes live, and why not in the message ──────────────────────────────────────────────
//
// Supabase Storage, bucket `chat-attachments`, never the database. The obvious alternative is to
// base64 the file into the message's content blocks, which works and is wrong: a 2 MB screenshot
// becomes ~2.7 MB of jsonb stored forever, re-read on every rehydrate of that conversation, and
// carried in full to the model on every subsequent turn of the thread. Storage holds the bytes and
// the message holds a URL.
//
// The bucket is PUBLIC, matching the existing `assets` and `page-assets` buckets. Two things force
// it: Anthropic has to be able to fetch an image by URL for vision to work at all, and a rehydrated
// transcript has to keep resolving months later — a signed URL that expires would leave a broken
// image in an old conversation. Paths are UUID-prefixed so they are not enumerable, but this is
// unguessable rather than access-controlled, and anything genuinely sensitive should not be dropped
// into a chat. Said plainly here because the alternative is someone assuming otherwise.
//
// ── What happens to each kind of file ─────────────────────────────────────────────────────────────
//
// Images become real image blocks, so the model SEES them. Text-ish files (md, txt, csv, json,
// code) are read and inlined as text, because a URL to a text file is useless to a model that
// cannot fetch it. Everything else is refused at the door with its own name in the message, rather
// than accepted and silently ignored — a file that uploads and then does nothing is worse than one
// that was never allowed.
//
// PDF and DOCX are refused for now. Extracting them needs a dependency this repo does not have, and
// accepting them without one would mean attaching a file the model cannot read.
import { randomUUID } from "node:crypto";

import type { Anthropic } from "@anthropic-ai/sdk";

import { supabaseAdmin } from "@/lib/db/supabase";

export const ATTACHMENT_BUCKET = "chat-attachments";

/** Anthropic's own ceiling for an image is 5 MB; text files are capped lower because they are
 *  inlined into the prompt and a 10 MB CSV would eat the context window on its own. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_BYTES = 512 * 1024;

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Read as text if the mime says so, or if the extension does — browsers report .md and .csv
 *  inconsistently, and often hand over an empty type for anything unfamiliar. */
const TEXT_EXTENSIONS = /\.(md|markdown|txt|csv|tsv|json|ya?ml|html?|xml|log|ts|tsx|js|jsx|py|sql|sh|css)$/i;

export type AttachmentKind = "image" | "text" | "rejected";

export interface StoredAttachment {
  kind: AttachmentKind;
  name: string;
  mime: string;
  size: number;
  /** Images only: the public URL the model and the transcript both read. */
  url?: string;
  /** Text-ish files only: the contents, already truncated if they were long. */
  text?: string;
  /** Rejected files only: why, in words a person can act on. */
  reason?: string;
}

export function classify(name: string, mime: string): AttachmentKind {
  if (IMAGE_MIMES.has(mime)) return "image";
  if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXTENSIONS.test(name)) return "text";
  return "rejected";
}

/** Why a file was refused. Names the file and the actual limit — "upload failed" tells nobody anything. */
function rejectionFor(name: string, mime: string, size: number): string | null {
  const kind = classify(name, mime);
  if (kind === "rejected") {
    if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
      return `PDFs cannot be read yet — paste the relevant text instead, or export it as .md or .txt.`;
    }
    if (/\.(docx?|pages)$/i.test(name)) {
      return `Word documents cannot be read yet — export as .md or .txt and attach that.`;
    }
    return `${mime || "this file type"} cannot be read. Images and text files (.md, .txt, .csv, .json, code) work.`;
  }
  if (kind === "image" && size > MAX_IMAGE_BYTES) {
    return `Image is ${(size / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB.`;
  }
  if (kind === "text" && size > MAX_TEXT_BYTES) {
    return `Text file is ${(size / 1024).toFixed(0)} KB; the limit is 512 KB.`;
  }
  return null;
}

/**
 * Take one uploaded file and turn it into something a turn can use.
 *
 * Never throws for a bad file — a rejected attachment comes back as a `rejected` record so the
 * caller can report every file's outcome in one answer, rather than the first failure killing an
 * upload of five.
 */
export async function storeAttachment(input: {
  sessionId: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
}): Promise<StoredAttachment> {
  const { sessionId, bytes } = input;
  const name = (input.name || "file").slice(0, 200);
  const mime = input.mime || "application/octet-stream";
  const size = bytes.byteLength;

  const reason = rejectionFor(name, mime, size);
  if (reason) return { kind: "rejected", name, mime, size, reason };

  const kind = classify(name, mime);

  if (kind === "text") {
    // Inlined, so it never touches storage: the model needs the CONTENT, and a URL it cannot fetch
    // would be an attachment that silently does nothing.
    const text = new TextDecoder().decode(bytes);
    return { kind: "text", name, mime, size, text };
  }

  // Session id in the path so a conversation's files are grouped; a UUID so nothing is enumerable
  // and two files of the same name never collide.
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const path = `${sessionId}/${randomUUID()}${ext}`;

  const { error } = await supabaseAdmin.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (error) {
    return { kind: "rejected", name, mime, size, reason: `Upload failed: ${error.message}` };
  }

  const { data } = supabaseAdmin.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path);
  return { kind: "image", name, mime, size, url: data.publicUrl };
}

/** How many characters of one text file to inline before cutting it. Generous enough for a brief or
 *  a transcript, bounded so one CSV cannot crowd out the conversation it was attached to. */
const TEXT_INLINE_LIMIT = 60_000;

/**
 * Turn stored attachments into the content blocks that ride with the user's message.
 *
 * Images come first: a model reads an instruction better when the thing it refers to is already in
 * front of it. Everything is labelled with its filename, because "the screenshot" and "the second
 * screenshot" have to mean something when the person refers back to them three turns later.
 */
export function attachmentBlocks(items: StoredAttachment[]): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];

  for (const a of items) {
    if (a.kind !== "image" || !a.url) continue;
    blocks.push({ type: "text", text: `Attached image: ${a.name}` });
    blocks.push({ type: "image", source: { type: "url", url: a.url } });
  }

  for (const a of items) {
    if (a.kind !== "text" || typeof a.text !== "string") continue;
    const clipped = a.text.length > TEXT_INLINE_LIMIT
      ? `${a.text.slice(0, TEXT_INLINE_LIMIT)}\n…[truncated at ${TEXT_INLINE_LIMIT} characters]`
      : a.text;
    blocks.push({ type: "text", text: `Attached file ${a.name}:\n\n${clipped}` });
  }

  // Refusals are told to the MODEL too, not just shown in the UI. Otherwise someone writes "use the
  // spec I attached", the file was a PDF that never arrived, and the model answers as though it had
  // read something.
  const refused = items.filter((a) => a.kind === "rejected");
  if (refused.length) {
    blocks.push({
      type: "text",
      text: `These files could not be attached and you have NOT seen them: ${
        refused.map((r) => `${r.name} (${r.reason})`).join("; ")
      }. If the person refers to their contents, say plainly that the file did not come through.`,
    });
  }

  return blocks;
}
