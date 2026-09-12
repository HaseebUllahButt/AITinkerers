import { NextRequest, NextResponse } from "next/server";
import { setContactedOverride, isAuthorContacted } from "@/lib/db/queries";

// GET — current effective contacted state for one author.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const state = await isAuthorContacted(id);
  return NextResponse.json(state);
}

// PATCH — manually set/clear an author's "contacted" state (the Emailed toggle in the
// prospect drawer). Body: { contacted: boolean | null }. true = never email again,
// false = email again (override history), null = revert to derived-from-outreach.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => ({}));
    const value = body.contacted === null ? null : body.contacted === true ? true : body.contacted === false ? false : null;
    await setContactedOverride(id, value);
    const state = await isAuthorContacted(id);
    return NextResponse.json({ ok: true, ...state });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
