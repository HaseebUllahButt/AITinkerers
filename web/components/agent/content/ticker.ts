// The ONE ticker.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §7.6. Every live readout in the transcript (step durations today,
// ask countdowns tomorrow) shares this single 100ms interval and writes its own `textContent`
// directly. The alternative — a `setInterval` + `setState` per step — is 200 renders/sec on a
// 20-step tree and erases every memoization win in §5.
//
// Two properties this module has to keep:
//   1. The interval only exists while something is subscribed. An idle tab must have no timers, so
//      the last unsubscribe clears it rather than leaving a no-op timer running for the session.
//   2. Unsubscribing is idempotent and safe DURING a tick. React 19 StrictMode double-invokes
//      effects, so the same cleanup can run twice, and a `paint()` callback is free to unsubscribe
//      itself (a step settling on the very tick it is painted).
//
// No "use client": this is a plain module with no JSX and no import-time DOM access, so it can be
// pulled in from either side of the boundary. Nothing subscribes during SSR, so no timer is ever
// created on the server.

import { TICKER_INTERVAL_MS } from "../constants";

type TickFn = () => void;

const subscribers = new Set<TickFn>();

let intervalId: ReturnType<typeof setInterval> | null = null;

function tick() {
  // Iterate a snapshot: a callback may unsubscribe (or subscribe) itself mid-tick, and mutating a
  // Set while for-of'ing it silently skips entries.
  for (const fn of Array.from(subscribers)) {
    try {
      fn();
    } catch (err) {
      // One bad paint callback must not abort the remaining subscribers for this tick, and must not
      // leave an uncaught error escaping a timer where no boundary can catch it.
      console.error("[agent] ticker subscriber threw", err);
    }
  }
}

/**
 * Subscribe to the shared 100ms ticker. Returns the unsubscribe function.
 *
 * Call it from an effect and return the result as the cleanup:
 * ```ts
 * useEffect(() => { paint(); return subscribeToTicker(paint); }, [running, startMs]);
 * ```
 */
export function subscribeToTicker(fn: TickFn): () => void {
  subscribers.add(fn);
  if (intervalId === null) {
    intervalId = setInterval(tick, TICKER_INTERVAL_MS);
  }

  // `done` makes a double-cleanup a no-op. Without it, the second call would `delete` a callback
  // that a LATER subscribe had legitimately re-added under the same identity (module-scope `paint`
  // helpers are stable across StrictMode's mount/unmount/mount), stopping that step's clock.
  let done = false;
  return () => {
    if (done) return;
    done = true;
    subscribers.delete(fn);
    if (subscribers.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

/** Live subscriber count. Diagnostics and tests only — do not branch render logic on it. */
export function tickerSubscriberCount(): number {
  return subscribers.size;
}

/** Whether the shared interval is currently armed. Diagnostics and tests only. */
export function isTickerRunning(): boolean {
  return intervalId !== null;
}
