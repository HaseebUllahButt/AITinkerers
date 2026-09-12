import { NextResponse } from "next/server";
import { getPaymentThreads } from "@/lib/db/queries";

// GET — every thread that closed as a deal (agreed = owed) plus anything with a payment status.
export async function GET() {
  try {
    return NextResponse.json({ threads: await getPaymentThreads() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
