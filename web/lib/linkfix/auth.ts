import { NextRequest } from "next/server";
import { auth } from "@auth";

// Same convention as the other cron-driven routes: Vercel cron / QStash (CRON_SECRET as a Bearer
// header or ?key=), or a signed-in session for the buttons on the 404s page.
export async function authorized(req: NextRequest): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  if (req.nextUrl.searchParams.get("key") === secret) return true;
  return Boolean(await auth().catch(() => null));
}
