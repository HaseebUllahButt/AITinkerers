import { NextRequest, NextResponse } from "next/server";
import { getAuthorDetail, upsertContact } from "@/lib/db/queries";
import { resolveEmailCascade } from "@/lib/enrich/cascade";
import { isRoleEmail } from "@/lib/enrich/personFilter";

export const maxDuration = 120;
const EMAIL_RE = /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/;

// POST — run the full email-finding cascade for ONE author and return the verbose steps
// + result. Stores the found email as a contact (same as a bulk run).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await getAuthorDetail(id);
  if (!d) return NextResponse.json({ error: "not found" }, { status: 404 });

  const host = d.domain?.host as string | undefined;
  if (!host) return NextResponse.json({ error: "no publication domain for this author", steps: [], found: false });

  const steps: string[] = [];
  const issues: string[] = [];
  let discoveredLinkedin: string | null = null;
  const target = { id, name: d.author.full_name, host, publication: d.domain?.name ?? host };
  let r = await resolveEmailCascade(target, {
    onStep: (s) => steps.push(s),
    onIssue: (m) => issues.push(m),
    onLinkedin: (url) => { discoveredLinkedin = url; },
    patternCache: new Map(),
    hunterDomains: new Map(),
    domainVerify: new Map(),
  }).catch(() => null);

  // Persist the LinkedIn found en route (even if no email turned up).
  if (discoveredLinkedin) {
    await upsertContact({
      author_id: id, type: "linkedin", value: discoveredLinkedin,
      confidence: 0.85, source: "linkedin-cascade", verified_syntax: true,
    }).catch(() => {});
  }

  if (r) {
    const e = r.email.toLowerCase().trim();
    if (!EMAIL_RE.test(e) || isRoleEmail(e)) r = null;
    else r = { ...r, email: e };
  }
  if (r) {
    await upsertContact({
      author_id: id, type: "mailto", value: `mailto:${r.email}`,
      confidence: r.score ? r.score / 100 : 0.8, source: r.source, verified_syntax: true,
    }).catch(() => {});
  }

  // status: found | error (a provider failed, so the miss may not be real) | not_found
  const status = r ? "found" : (issues.length ? "error" : "not_found");
  return NextResponse.json({ steps, issues, status, found: !!r, email: r?.email ?? null, source: r?.source ?? null });
}
