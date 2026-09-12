// One switch that turns every METERED data provider off.
//
// The point is proof, not thrift. The free-stack work (docs/FREE_STACK_PLAN.md) added free routes
// for verification, authority signals, search and author discovery, and the claim that they stand
// on their own is worth exactly nothing until it can be demonstrated. `PROVIDER_FREE_ONLY=1` makes
// the demonstration a one-line config change instead of an afternoon of pulling keys out of Vercel
// and forgetting to put them back.
//
// Scope is deliberately narrow. This disables providers that BILL PER LOOKUP:
//   Hunter, enrich.so, Reoon, Serper, Ahrefs
// It does NOT touch:
//   - the LLM (OpenRouter / Anthropic) — drafting quality is the product, and a pitch nobody wants
//     to read is not a saving. Turning it off would test nothing about data sourcing anyway.
//   - Blitz — unlimited credits, and the highest-yield single source we have.
//   - Tavily / Google CSE — renewing free tiers; they ARE part of the free stack.
//   - SMTP sending — unrelated, and the no-fallback-sender rule already governs it.

export function freeOnlyMode(): boolean {
  return process.env.PROVIDER_FREE_ONLY === "1";
}

/**
 * Should this metered provider be used at all?
 *
 * Every provider's own `…Enabled()` composes with this, so a caller cannot accidentally bypass the
 * switch by reading its env var directly — and the honest reporting each provider already does
 * ("Hunter had no match") keeps working, because a disabled provider behaves exactly like an
 * unconfigured one, which every call site already handles.
 */
export function meteredProviderEnabled(configured: boolean): boolean {
  return configured && !freeOnlyMode();
}

/**
 * A metered provider's credential, or null when free-only mode is on.
 *
 * Gate the KEY, not just the `…Enabled()` helper. Several providers read their env var again inside
 * the fetch function (`serpAnalysis`, `topCompetitors`, the Ahrefs `call` helper), so a switch that
 * only flipped `…Enabled()` would be bypassed by exactly the code paths it was meant to stop — and
 * silently, since those functions already return null on a missing key. Withholding the credential
 * closes the hole at the single point every caller must pass through.
 */
export function meteredKey(value: string | undefined | null): string | null {
  if (freeOnlyMode()) return null;
  const v = (value ?? "").trim();
  return v || null;
}
