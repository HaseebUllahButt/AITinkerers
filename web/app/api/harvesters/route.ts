import { NextRequest, NextResponse } from "next/server";
import { getHarvesters, updateHarvester } from "@/lib/db/queries";

export async function GET() {
  const harvesters = await getHarvesters();
  return NextResponse.json(harvesters);
}

export async function PATCH(req: NextRequest) {
  const { id, enabled, config } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await updateHarvester(id, { enabled, config });
  return NextResponse.json({ ok: true });
}
