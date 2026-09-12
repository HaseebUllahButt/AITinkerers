import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";

import { getHermesSession } from "@/lib/db/queries";
import { storeAttachment, type StoredAttachment } from "@/lib/hermes/attachments";

// POST multipart/form-data with one or more "files" fields → store them against this session and
// return a record per file describing what happened to each.
//
// Scoped to the session and to its owner. NOT widened for the superuser: reading someone's
// conversation is one thing, adding files to it is another, and this is a write.
//
// Every file gets an outcome, including the refused ones. A partial upload that reports only its
// successes leaves the person believing all five landed.
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await auth().catch(() => null);
  const email = s?.user?.email as string | undefined;
  if (!email) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const session = await getHermesSession(id).catch(() => null);
  if (!session) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  if (session.user_email !== email) return NextResponse.json({ ok: false, error: "not yours" }, { status: 403 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "expected multipart/form-data" }, { status: 400 });
  }

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) return NextResponse.json({ ok: false, error: "no files" }, { status: 400 });
  // Ten at a time. Not a storage limit — a turn carrying thirty images is a context problem, and the
  // person is better told now than after a slow upload.
  if (files.length > 10) {
    return NextResponse.json({ ok: false, error: "Ten files at a time, please." }, { status: 400 });
  }

  const stored: StoredAttachment[] = [];
  for (const f of files) {
    try {
      stored.push(await storeAttachment({
        sessionId: id,
        name: f.name,
        mime: f.type,
        bytes: new Uint8Array(await f.arrayBuffer()),
      }));
    } catch (e: unknown) {
      // One unreadable file must not take down the other nine.
      stored.push({
        kind: "rejected", name: f.name, mime: f.type, size: f.size,
        reason: e instanceof Error ? e.message : "could not be read",
      });
    }
  }

  return NextResponse.json({ ok: true, attachments: stored });
}
