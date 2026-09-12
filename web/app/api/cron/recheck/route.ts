import { after, NextRequest, NextResponse } from "next/server";

import { dbConfigured } from "@/lib/db/pg";
import { runRechecks } from "@/lib/audit/recheck";

// Re-audit sites that have channels bound to them, and tell those channels what moved.
// Intended for the host's own scheduler:
//
//   */30 * * * * curl -s -X POST -H "Authorization: Bearer $CRON_SECRET" \
//     https://your-app/api/cron/recheck
//
// Audits take minutes and several sites take longer than any HTTP budget, so the work runs in
// `after` — the response only confirms the run started. The schedule itself lives outside this
// process (cron, systemd timer, a hosted scheduler); this route is what it calls.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    console.warn("[cron] rejected recheck:", secret ? "bad secret" : "CRON_SECRET not set");
    return new NextResponse("unauthorized", { status: 401 });
  }
  if (!dbConfigured()) {
    return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
  }

  after(async () => {
    const summary = await runRechecks();
    console.log(
      `[recheck] due=${summary.due} checked=${summary.checked} notified=${summary.notified}` +
      (summary.errors.length ? ` errors=${summary.errors.join("; ")}` : ""),
    );
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}

export const GET = POST;
