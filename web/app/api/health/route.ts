import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/db/supabase";

export async function GET() {
  const checks: Record<string, string> = {};

  // Supabase connectivity
  try {
    const { error } = await supabaseAdmin.from("domains").select("id").limit(1);
    checks.supabase = error ? `error: ${error.message}` : "ok";
  } catch (e: any) {
    checks.supabase = `error: ${e?.message}`;
  }

  // LLM
  checks.llm = process.env.OPENROUTER_API_KEY ? "configured" : "not configured (using templates)";
  checks.playwright = process.env.PLAYWRIGHT_ENABLED === "true" ? "enabled" : "disabled";
  checks.brave = process.env.BRAVE_SEARCH_API_KEY ? "configured" : "not configured";

  const allOk = checks.supabase === "ok";

  return NextResponse.json({
    status: allOk ? "ok" : "degraded",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    checks,
  }, { status: allOk ? 200 : 503 });
}
