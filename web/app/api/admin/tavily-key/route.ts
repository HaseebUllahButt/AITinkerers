import { NextRequest, NextResponse } from "next/server";
import { getTavilyUsage, listTavilyKeys, addTavilyKey, removeTavilyKey } from "@/lib/search/tavilyUsage";

// GET — the rotating key pool (masked, never the raw keys) + live usage.
export async function GET() {
  const [keys, usage] = await Promise.all([listTavilyKeys(), getTavilyUsage()]);
  return NextResponse.json({ keys, usage });
}

// POST — add one or many Tavily keys to the pool. Accepts { key, label?, fallback? } or
// { keys: "a\nb\nc" }. fallback=true marks a PAID key used only after free keys are exhausted.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const raw: string = typeof body.keys === "string" ? body.keys : (typeof body.key === "string" ? body.key : "");
  const label: string | undefined = typeof body.label === "string" ? body.label : undefined;
  const fallback = body.fallback === true;
  const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return NextResponse.json({ error: "key required" }, { status: 400 });
  try {
    for (const k of parts) await addTavilyKey(k, parts.length === 1 ? label : undefined, fallback);
    return NextResponse.json({ ok: true, added: parts.length, keys: await listTavilyKeys() });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// DELETE ?id= — remove one key from the pool.
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await removeTavilyKey(id);
  return NextResponse.json({ ok: true, keys: await listTavilyKeys() });
}
