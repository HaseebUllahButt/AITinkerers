import { NextResponse } from "next/server";

import { ENGINES, engineStatus } from "@/lib/audit/engines";
import { llmDiagnose } from "@/lib/providers/llm";
import { searchProviders } from "@/lib/search/webSearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ProviderStatus {
  id: string;
  label: string;
  group: "model" | "engine" | "search";
  /** A key is present in the environment. */
  configured: boolean;
  /** The key was actually accepted. Null when not probed. */
  working: boolean | null;
  detail: string;
}

// A status page that only reports "a key is set" is the thing that hid a dead key for an entire
// session. So this makes one real, tiny request per provider — and caches the verdict, because
// nobody needs it re-probed on every page view.
const TTL = 60_000;
let cache: { at: number; payload: unknown } | null = null;

async function probeSearch(provider: string): Promise<{ working: boolean; detail: string }> {
  try {
    if (provider === "exa") {
      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": process.env.EXA_API_KEY ?? "" },
        body: JSON.stringify({ query: "SearchOps", numResults: 1, type: "auto" }),
        signal: AbortSignal.timeout(12_000),
      });
      return res.ok
        ? { working: true, detail: "Answering." }
        : { working: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
    }
    return { working: true, detail: "Configured; not probed." };
  } catch (e) {
    return { working: false, detail: e instanceof Error ? e.message : "Request failed." };
  }
}

export async function GET() {
  if (cache && Date.now() - cache.at < TTL) return NextResponse.json(cache.payload);

  const providers: ProviderStatus[] = [];

  // The model that writes prompts, suggestions and artefacts. Everything degrades without it.
  const llm = await llmDiagnose();
  const llmConfigured = Boolean(
    process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.length > 20,
  );
  providers.push({
    id: "llm",
    label: "Reasoning model",
    group: "model",
    configured: llmConfigured,
    working: llmConfigured ? llm.ok : false,
    detail: llmConfigured
      ? (llm.ok ? "Answering." : llm.reason)
      : "No OPENROUTER_API_KEY set.",
  });

  // Answer engines — configuration only. Probing four of them on every load would cost real
  // money for a status widget; the audit reports its own per-engine failures.
  for (const s of engineStatus()) {
    providers.push({
      id: s.engine,
      label: ENGINES.find((e) => e.id === s.engine)?.label ?? s.engine,
      group: "engine",
      configured: s.available,
      working: null,
      detail: s.available ? "Key present; verified when an audit runs." : s.reason,
    });
  }

  const configuredSearch = searchProviders();
  const probes = await Promise.all(configuredSearch.map((p) => probeSearch(p)));
  for (const [i, p] of configuredSearch.entries()) {
    providers.push({
      id: p,
      label: p.charAt(0).toUpperCase() + p.slice(1),
      group: "search",
      configured: true,
      working: probes[i].working,
      detail: probes[i].detail,
    });
  }
  if (!configuredSearch.length) {
    providers.push({
      id: "search",
      label: "Web search",
      group: "search",
      configured: false,
      working: false,
      detail: "No EXA_API_KEY configured. Competitor discovery uses Exa only.",
    });
  }

  const payload = { checkedAt: new Date().toISOString(), providers };
  cache = { at: Date.now(), payload };
  return NextResponse.json(payload);
}
