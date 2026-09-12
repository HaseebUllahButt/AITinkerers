import { NextRequest, NextResponse } from "next/server";
import { getSuppressions, addSuppression, deleteSuppression } from "@/lib/db/queries";

export async function GET() {
  const list = await getSuppressions();
  return NextResponse.json(list);
}

export async function POST(req: NextRequest) {
  const { type, value, reason } = await req.json();
  if (!type || !value) return NextResponse.json({ error: "type and value required" }, { status: 400 });
  await addSuppression(type, value, reason);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await deleteSuppression(id);
  return NextResponse.json({ ok: true });
}
