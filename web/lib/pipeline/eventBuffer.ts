// In-process ring buffer for live SSE replay, PLUS a durable Redis mirror (snapshot +
// heartbeat) so the reconnect poll on another serverless instance still sees progress and
// can tell a run is alive. Redis is optional (local dev uses the in-memory buffer only).

import { redis } from "@/lib/redis";

const MAX = 600;
const SNAP_KEY = "pipeline:buffer";

interface BufferedRun {
  runId: string;
  startedAt: number;
  events: any[];
  done: boolean;
  listeners: Set<(e: any) => void>;
}

let current: BufferedRun | null = null;

export function startBuffer(runId: string) {
  current = { runId, startedAt: Date.now(), events: [], done: false, listeners: new Set() };
}

export function pushEvent(event: any) {
  if (!current) return;
  current.events.push(event);
  if (current.events.length > MAX) current.events.shift();
  for (const fn of current.listeners) fn(event);
}

export function finishBuffer() {
  if (current) current.done = true;
}

export function getBuffer() {
  return current ? { runId: current.runId, startedAt: current.startedAt, events: [...current.events], done: current.done } : null;
}

export function subscribe(fn: (e: any) => void): () => void {
  if (!current) return () => {};
  current.listeners.add(fn);
  return () => current?.listeners.delete(fn);
}

export function isRunning() {
  return !!current && !current.done;
}

// ─── Durable Redis mirror (heartbeat + last events) ─────────────────────────────

export async function snapshotBuffer(): Promise<void> {
  const r = redis();
  if (!r || !current) return;
  await r.set(SNAP_KEY, JSON.stringify({
    runId: current.runId, startedAt: current.startedAt, done: current.done,
    events: current.events.slice(-200), heartbeat: Date.now(),
  }), { ex: 3600 }).catch(() => {});
}

// { runId, startedAt, done, events, heartbeat } from Redis (any instance) or in-memory.
export async function getBufferDurable(): Promise<any | null> {
  const r = redis();
  if (r) {
    const raw = await r.get<any>(SNAP_KEY).catch(() => null);
    if (raw) return typeof raw === "string" ? JSON.parse(raw) : raw;
  }
  const b = getBuffer();
  return b ? { ...b, heartbeat: Date.now() } : null;
}

// A run is "alive" if its heartbeat is recent (the executing instance snapshots every few
// seconds). Stale/missing heartbeat → the run died (function killed / process restarted).
export async function isRunAlive(maxStaleMs = 90_000): Promise<boolean> {
  if (isRunning()) return true;
  const snap = await getBufferDurable();
  return !!snap && !snap.done && typeof snap.heartbeat === "number" && (Date.now() - snap.heartbeat) < maxStaleMs;
}
