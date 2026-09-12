import { NextRequest, NextResponse } from "next/server";
import { getSeeds, upsertSeed, deleteSeed } from "@/lib/db/queries";

export async function GET() {
  const seeds = await getSeeds();
  return NextResponse.json(seeds);
}

export async function POST(req: NextRequest) {
  const { name, aliases, enabled, category } = await req.json();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  await upsertSeed(name, aliases ?? [], enabled ?? true, category ?? "competitor");
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const { name, aliases, enabled, category } = await req.json();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  await upsertSeed(name, aliases ?? [], enabled ?? true, category ?? "competitor");
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deleteSeed(id);
  return NextResponse.json({ ok: true });
}
