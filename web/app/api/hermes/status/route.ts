import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/lib/auth/service";
import { hermesEnabled, hermesHealth } from "@/lib/hermes/client";

export const maxDuration = 20;

/**
 * Is Hermes actually working, and if not, which credential is missing?
 *
 * `hermesHealth()` existed with zero callers, which meant there was no way to answer that question
 * from inside SearchOps — the only diagnostic was someone curling the host by hand. That is the wrong
 * place for this to live, because Hermes fails *quietly* by design: every call site does
 * `(await hermesResearch(q)) ?? fallback()` so an outage degrades SearchOps instead of breaking it. Silent
 * degradation plus no status surface means Hermes could be dead for a week and look identical to
 * Hermes being merely unconfigured.
 *
 * The two directions are reported separately because they fail independently and for different
 * reasons, and conflating them sends you looking in the wrong place:
 *
 *   summitToHermes — can WE reach the service? Breaks on a bad HERMES_BASE_URL or a missing inbound
 *                    token on their side.
 *   hermesToSearchOps — can the AGENT reach US? Breaks on a SUMMIT_API_URL still pointing at localhost,
 *                    or a SUMMIT_SERVICE_TOKEN that does not match our HERMES_TOKEN.
 *
 * We read the second direction off the remote's own unauthenticated /health, which reports each
 * credential's PRESENCE (never its value) plus the API URL it will call. That is what turns "Hermes
 * doesn't work" into "SUMMIT_API_URL is still 127.0.0.1".
 */
export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!hermesEnabled()) {
    return NextResponse.json({
      ok: false,
      configured: false,
      detail: "HERMES_BASE_URL is not set. Every Hermes path is inert until it is.",
      blockers: ["Set HERMES_BASE_URL on SearchOps to the Hermes host."],
    });
  }

  const base = (process.env.HERMES_BASE_URL ?? "").trim().replace(/\/$/, "");
  const summitToHermes = await hermesHealth();

  // The remote's own view of its config. Deliberately unauthenticated on their side so this check
  // still works when the token is exactly what is wrong.
  let remote: {
    model?: string;
    tools?: number;
    summit_api?: string;
    configured?: Record<string, boolean>;
    browser?: boolean;
  } | null = null;
  let remoteError: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(`${base}/health`, { signal: ctrl.signal, cache: "no-store" });
      remote = res.ok ? await res.json() : null;
      if (!res.ok) remoteError = `health returned ${res.status}`;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    remoteError = e instanceof Error ? e.message : "unreachable";
  }

  const cfg = remote?.configured ?? {};
  const blockers: string[] = [];

  if (!summitToHermes.reachable && !remote) {
    blockers.push(`Hermes is not reachable at ${base} (${summitToHermes.detail ?? remoteError ?? "unknown"}).`);
  }
  if (remote && cfg.anthropic_key === false) {
    blockers.push("Hermes-side ANTHROPIC_API_KEY is not set — the agent cannot think. Set it on the Hermes host.");
  }
  if (remote && cfg.inbound_token === false) {
    blockers.push(
      "Hermes-side HERMES_INBOUND_TOKEN / SUMMIT_SERVICE_TOKEN is not set, so it refuses all authenticated " +
        "calls (fail-closed). Set SUMMIT_SERVICE_TOKEN there to the same value as SearchOps's HERMES_TOKEN.",
    );
  }
  // The default is localhost, which on a deployed host reaches nothing — so the agent's 13 tools all
  // fail even when everything else is correct. Worth calling out specifically rather than as a generic
  // connectivity error.
  const summitApi = remote?.summit_api ?? "";
  if (remote && /127\.0\.0\.1|localhost/.test(summitApi)) {
    blockers.push(
      `Hermes-side SUMMIT_API_URL is still ${summitApi} — on a deployed host that reaches nothing, so ` +
        "every tool will fail. Point it at SearchOps's public URL.",
    );
  }
  if (remote && cfg.summit_service_token === false) {
    blockers.push("Hermes-side SUMMIT_SERVICE_TOKEN is not set — the agent cannot authenticate back to SearchOps.");
  }
  if (remote && remote.browser === false) {
    // Not a blocker: /v1/scrape still works over plain HTTP. But it is the capability people assume
    // they have, so it should be visible rather than discovered from a low hit rate later.
    blockers.push(
      "NOTE (not fatal): no browser installed on the Hermes host, so /v1/scrape cannot read " +
        "bot-protected pages — which is most of Hermes's value for enrichment.",
    );
  }

  return NextResponse.json({
    ok: blockers.length === 0,
    configured: true,
    baseUrl: base,
    summitToHermes: { reachable: summitToHermes.reachable, detail: summitToHermes.detail ?? null },
    hermesToSearchOps: {
      summitApiUrl: summitApi || null,
      serviceTokenSet: cfg.summit_service_token ?? null,
    },
    remote: remote
      ? { model: remote.model, tools: remote.tools, browser: remote.browser ?? null, configured: cfg }
      : { error: remoteError },
    blockers,
  });
}
