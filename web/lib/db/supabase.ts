// The Supabase service client, constructed lazily.
//
// ── Why lazy, and not a plain `createClient()` at module scope ──────────────────────────────────────
//
// It used to be eager:
//
//     const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
//     export const supabaseAdmin = createClient(url, serviceKey, …);
//
// which throws `supabaseUrl is required.` the instant the module is IMPORTED with those vars absent.
// The `!` assertions are TypeScript-only; they silence the compiler and do nothing at runtime.
//
// That made the build depend on runtime secrets. `next build`'s "Collecting page data" step imports
// every route module to decide what can be statically rendered, and 102 API routes reach this file —
// so on any builder without the secrets present, the build died at whichever route its worker pool
// happened to touch first (observed: `Failed to collect page data for /api/admin/wipe`, though the
// route was incidental, not special). Vercel never showed it because its build environment carries
// the env vars; a Docker/kaniko build of the same commit fails every time.
//
// A missing credential should fail when something actually tries to reach the database, with a message
// naming the variable — not during a build that has no business needing it.
//
// ── Why a Proxy rather than exporting a getter function ────────────────────────────────────────────
//
// 102 call sites already use `supabaseAdmin.from(...)` as a value. A `getSupabaseAdmin()` function
// would be marginally cleaner but forces a 102-file mechanical refactor for no behavioural gain, and
// every one of those edits is a chance to typo. The Proxy keeps the exported shape identical while
// deferring construction to first property access.
//
// ── Env var precedence ─────────────────────────────────────────────────────────────────────────────
//
// `SUPABASE_URL` is checked BEFORE `NEXT_PUBLIC_SUPABASE_URL`, deliberately. Next.js statically
// inlines `NEXT_PUBLIC_*` at build time, so a value absent during the build can end up baked in as
// `undefined` and setting it at runtime would not help. A non-public name is read from the real
// runtime environment, which is what a container needs. The NEXT_PUBLIC_ form stays supported so
// existing deployments (Vercel included) keep working with no config change.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/** Build the service client on first use, or explain exactly which variable is missing. */
function serviceClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const missing = [
    !url && "SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)",
    !serviceKey && "SUPABASE_SERVICE_ROLE_KEY",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Supabase is not configured — missing ${missing.join(" and ")}. ` +
      "Set it in the deployment's environment (runtime is enough; the build does not need it).",
    );
  }

  cached = createClient(url!, serviceKey!, { auth: { persistSession: false } });
  return cached;
}

/**
 * Service-role client. Server-side only — it bypasses RLS.
 *
 * Behaves exactly like the client it replaced; it is just not constructed until something reads a
 * property off it. Methods are bound to the real client so `this` is correct when a call is
 * destructured or passed around.
 */
export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = serviceClient() as unknown as Record<string | symbol, unknown>;
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(_target, prop) {
    return Reflect.has(serviceClient() as unknown as object, prop);
  },
});

// NOTE: the anon/public client that used to live here (`export const supabase`) has been removed.
// It was imported by nothing in `src/` — grep-verified across both .ts and .tsx, including every
// "use client" component — so it existed only to make NEXT_PUBLIC_SUPABASE_ANON_KEY a hard build
// requirement for a client nobody used. `scripts/025_enable_rls_other_projects.mjs` builds its own
// anon client from the same env var and is unaffected. If a browser-side client is ever genuinely
// needed, add it lazily the same way rather than at module scope.
