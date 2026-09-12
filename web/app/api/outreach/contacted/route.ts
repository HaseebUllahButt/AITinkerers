import { NextRequest, NextResponse } from "next/server";
import { getContactedAuthorIds } from "@/lib/db/queries";

// Author IDs already contacted/queued in OTHER campaigns (pass ?exclude_workflow=<id>).
export async function GET(req: NextRequest) {
  const exclude = req.nextUrl.searchParams.get("exclude_workflow") ?? undefined;
  const ids = await getContactedAuthorIds(exclude);
  return NextResponse.json({ authorIds: [...ids] });
}
