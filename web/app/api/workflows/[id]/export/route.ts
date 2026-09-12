import { NextRequest, NextResponse } from "next/server";
import { getWorkflow, getWorkflowProspects } from "@/lib/db/queries";

// GET — download the workflow's blog list as CSV (opens directly in Excel/Sheets):
// name, publication, website, domain rating, email, LinkedIn, and links to their articles.
function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [wf, { prospects }] = await Promise.all([getWorkflow(id), getWorkflowProspects(id, { limit: 5000 })]);

  const headers = ["Name", "Publication", "Website", "Domain rating", "Email", "LinkedIn", "Articles", "Article links"];
  const rows = prospects.map((p) => {
    const a: any = p.author ?? {};
    const domain: any = p.domain ?? {};
    const contacts: any[] = p.contacts ?? [];
    const articles: any[] = p.articles ?? [];
    const email = contacts.find((c) => c.type === "mailto")?.value?.replace(/^mailto:/, "") ?? "";
    const linkedin = contacts.find((c) => c.type === "linkedin")?.value ?? "";
    const website = domain.host ? `https://${domain.host}` : "";
    return [
      a.full_name ?? "",
      domain.name ?? domain.host ?? "",
      website,
      domain.dr_proxy_score != null ? domain.dr_proxy_score : "",
      email,
      linkedin,
      articles.length,
      articles.map((art) => art.url_canonical).filter(Boolean).join(" | "),
    ];
  });

  const csv = [headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const bom = "﻿"; // so Excel reads UTF-8 correctly
  const safeName = (wf?.name ?? "workflow").replace(/[^a-z0-9]+/gi, "_").toLowerCase();

  return new NextResponse(bom + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="blog-list_${safeName}.csv"`,
    },
  });
}
