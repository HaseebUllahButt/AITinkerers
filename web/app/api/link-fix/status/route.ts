import { NextResponse } from "next/server";
import { getLinkFixState, getPlan } from "@/lib/linkfix/run";

// GET — everything the 404s page needs to render progress and the plan summary.
export async function GET() {
  const state = await getLinkFixState().catch(() => null);
  if (!state) return NextResponse.json({ state: null, plan: null });
  const { fixes, unfixable } = await getPlan().catch(() => ({ fixes: [], unfixable: [] }));

  // A run is live if its heartbeat is fresh; chunks save state every pass.
  const running = !["done", "error", "idle"].includes(state.phase) && Date.now() - state.updatedAt < 15 * 60_000;
  const byAction = fixes.reduce<Record<string, number>>((m, f) => ((m[f.action] = (m[f.action] ?? 0) + 1), m), {});

  return NextResponse.json({
    state: { ...state, running },
    plan: { total: fixes.length, byAction, unfixable: unfixable.length },
  });
}
