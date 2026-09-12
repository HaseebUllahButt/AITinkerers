import { NextRequest, NextResponse } from "next/server";
import { auth } from "@auth";
import { followupsEnabled, setFollowupsEnabled } from "@/lib/email/followup";

async function signedIn(): Promise<boolean> {
  const s = await auth().catch(() => null);
  return !!s;
}

// GET — is auto follow-up currently on? PATCH { enabled } — the global kill-switch.
export async function GET() {
  if (!(await signedIn())) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  return NextResponse.json({ enabled: await followupsEnabled() });
}

export async function PATCH(req: NextRequest) {
  if (!(await signedIn())) return NextResponse.json({ error: "not signed in" }, { status: 401 });
  const { enabled } = await req.json().catch(() => ({}));
  await setFollowupsEnabled(!!enabled);
  return NextResponse.json({ enabled: !!enabled });
}
