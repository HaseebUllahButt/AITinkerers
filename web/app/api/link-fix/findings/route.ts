import { NextRequest, NextResponse } from "next/server";
import { getFindings, getPlan } from "@/lib/linkfix/run";
import type { PlannedFix } from "@/lib/linkfix/types";

// GET — the findings table for the page, and `?format=csv` for the ledger the SEO team tracks in
// Sheets. Full URLs throughout: a slug is not enough to hand to someone who has to go and look.
export async function GET(req: NextRequest) {
  const [findings, plan] = await Promise.all([getFindings().catch(() => []), getPlan().catch(() => ({ fixes: [], unfixable: [] }))]);
  const format = req.nextUrl.searchParams.get("format");
  const only = req.nextUrl.searchParams.get("verdict");

  const rows: PlannedFix[] = [...plan.fixes, ...plan.unfixable];
  if (format === "csv") {
    const q = (v: unknown) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ["Page URL", "Surface", "Change", "Field", "Link text", "URL before", "URL after", "Match", "Why"];
    const body = rows.map((f) =>
      [
        f.pageUrl,
        f.surface,
        f.action === "unlink" ? "Hyperlink removed" : f.action === "delete" ? "Item removed" : "Repointed",
        f.field,
        f.text,
        f.target ?? f.url ?? "",
        f.action === "unlink" ? "(link removed, text kept)" : f.action === "delete" ? "(item removed)" : (f.to ?? ""),
        f.score ?? "",
        f.reason,
      ].map(q).join(","),
    );
    return new NextResponse([head.map(q).join(","), ...body].join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="imagine-404s-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  }

  const visible = only ? findings.filter((f) => f.verdict === only) : findings.filter((f) => f.verdict === "broken" || f.verdict === "dashboard");
  return NextResponse.json({
    findings: visible.slice(0, 2000),
    truncated: visible.length > 2000,
    total: visible.length,
    fixes: rows.length,
  });
}
