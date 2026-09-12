import { NextRequest, NextResponse } from "next/server";
import { getEmailTemplates, createEmailTemplate } from "@/lib/db/queries";

export async function GET() {
  try {
    return NextResponse.json(await getEmailTemplates());
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { name, subject, body, guidance, channel } = await req.json();
    // LinkedIn notes carry no subject line, so only require it for email templates.
    if (!name || !body || (channel !== "linkedin" && !subject)) {
      return NextResponse.json({ error: "name, subject, body required" }, { status: 400 });
    }
    const tmpl = await createEmailTemplate({ name, subject: subject ?? "", body, guidance, channel });
    return NextResponse.json(tmpl, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
