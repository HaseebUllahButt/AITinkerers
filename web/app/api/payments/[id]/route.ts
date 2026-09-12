import { NextRequest, NextResponse } from "next/server";
import { getConversation, markPayment } from "@/lib/db/queries";
import { supabaseAdmin } from "@/lib/db/supabase";
import { deliverOutreach } from "@/lib/email/deliver";

// GET — the full conversation for a payment thread (to read before paying).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json({ conversation: await getConversation(id) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}

// POST { action: 'paid' | 'request' | 'reset' } — mark paid, or email the account that owns the
// thread (whose mailbox it is under) to process payment; reset back to owed.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const { action } = await req.json().catch(() => ({}));
    if (!["paid", "request", "reset"].includes(action)) return NextResponse.json({ error: "bad action" }, { status: 400 });
    await markPayment(id, action);

    if (action === "request") {
      const { data, error } = await supabaseAdmin
        .from("outreach_emails")
        .select("sender_email, agreed_price, subject, author:authors(full_name, domain:domains(host, name))")
        .eq("id", id).maybeSingle();
      // Fail closed: on a failed read this used to email the FALLBACK recipient a request
      // reading "Writer: the writer / Agreed amount: ?" and report ok. A real payment email
      // must never be assembled from defaults. (markPayment above already flipped the status;
      // 'request' is re-runnable, so refusing here loses nothing.)
      if (error) return NextResponse.json({ error: `Could not read the thread (${error.message}). No payment email was sent — try again.` }, { status: 503 });
      // No hardcoded fallback payer. A legacy thread with no sender on record used to bill one
      // named teammate by default — a person who may never have touched the deal — and the same
      // null is why nobody could tell whose mailbox the thread lived in. An unowned thread has
      // nobody to bill; say so rather than picking someone. (The status is already flipped and
      // 'request' is re-runnable, so refusing costs nothing but the email.)
      const payer = (data as any)?.sender_email as string | null;
      if (!payer) {
        return NextResponse.json({
          error: "This thread has no sender on record, so there's nobody to send the payment request to. It's still marked as requested — open the thread and send it from your own account, or handle the payment directly.",
        }, { status: 409 });
      }
      const name = (data as any)?.author?.full_name ?? "the writer";
      const pub = (data as any)?.author?.domain?.name ?? (data as any)?.author?.domain?.host ?? "";
      const price = (data as any)?.agreed_price;
      const body = `Payment due.\n\nWriter: ${name}\nPublication: ${pub}\nAgreed amount: ${price ?? "?"}\nThread: ${(data as any)?.subject ?? ""}\n\nPlease process this payment, then mark it paid on the Payments page.`;
      // The result decides the answer. This used to be discarded and the route reported
      // `ok: true, emailedTo` unconditionally — so a payer with no Gmail app password (which
      // deliverOutreach refuses on) got a success toast naming an email that never left.
      const res = await deliverOutreach({ to: payer, subject: `Payment due: ${name}${pub ? " (" + pub + ")" : ""}`, body, sender: payer })
        .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "send failed" }));
      if (!res.ok) {
        return NextResponse.json({
          error: `Marked as requested, but the payment email to ${payer} did not send: ${res.error ?? "send failed"}`,
        }, { status: 502 });
      }
      return NextResponse.json({ ok: true, emailedTo: payer });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
