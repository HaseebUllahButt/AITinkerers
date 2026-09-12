import { NextRequest, NextResponse } from "next/server";
import { checkAllKeys } from "@/lib/health/keys";
import { getTavilyUsage } from "@/lib/search/tavilyUsage";

// Services excluded from the banner alert (still checked/listed, just not warned about).
// openrouter: no longer used for generation, so its dead key must not alarm anyone.
const SUPPRESSED = new Set(["reoon", "hunter", "openrouter"]);

// GET /api/health/keys — status of every configured external API key + Tavily usage.
// ?force=1 bypasses the 10-min cache (used by a manual "recheck" button).
export async function GET(req: NextRequest) {
  const force = req.nextUrl.searchParams.get("force") === "1";
  const [keys, tavily] = await Promise.all([checkAllKeys(force), getTavilyUsage()]);
  const broken = keys.filter((k) => k.configured && !k.ok && !SUPPRESSED.has(k.service));

  // Amber warnings (not hard failures) — e.g. Tavily search quota nearly/fully used.
  const warnings: { label: string; message: string }[] = [];
  const hasPool = (tavily.poolTotal ?? 0) > 0;
  // With a key pool, only warn when the WHOLE pool is spent or down to its last key —
  // a single key crossing 90% is normal (rotation handles it). Without a pool, old thresholds.
  const poolLow = hasPool && tavily.poolActive <= 1;
  if (tavily.enabled && (tavily.over || tavily.error || (hasPool ? poolLow : tavily.near))) {
    warnings.push({
      label: "Tavily search",
      message: tavily.error
        ? `key error (${tavily.error.detail})`
        : hasPool
          ? (tavily.over
              ? `all ${tavily.poolTotal} Tavily keys are out for this month — add more in Settings`
              : `only ${tavily.poolActive} of ${tavily.poolTotal} Tavily keys left — add more in Settings`)
          : (tavily.over
              ? `monthly quota used up (${tavily.used}/${tavily.limit}) — add keys in Settings`
              : `nearly out (${tavily.used}/${tavily.limit} this month) — add keys in Settings`),
    });
  }

  return NextResponse.json({ keys, broken, warnings, tavily, healthy: broken.length === 0 && warnings.length === 0 });
}
