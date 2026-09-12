// Tracks an on-demand email/LinkedIn-finding run (one at a time), PER PERSON — a live
// status line + the steps taken — so the Email Finder shows one updating row per author.
//
// In-memory `current` is the fast hot path (per-step updates). Because a Vercel run spans
// MULTIPLE serverless invocations (chunked via QStash) and the status poll may hit a
// DIFFERENT instance, we also mirror the whole run to Upstash Redis as a JSON snapshot
// (throttled), and can restore `current` from it to resume a chunk. Redis is optional —
// with no Redis (local dev) everything stays in-memory and runs in one pass.

import { redis } from "@/lib/redis";

export interface EnrichPerson {
  name: string;
  authorId?: string;
  publication?: string;
  steps: string[];
  status: "running" | "found" | "not_found" | "error";
  email?: string;
  source?: string;
  issues?: string[];
  lastAt: number;
}

interface EnrichRun {
  key: string;
  campaignName?: string;
  total: number;
  done: number;
  found: number;
  bySource: Record<string, number>;
  running: boolean;
  aborted: boolean;
  startedAt: number;
  finishedAt?: number;
  people: Map<string, EnrichPerson>;
}

const MAX_STEPS = 60;
const SNAP_KEY = "enrich:snapshot";
const ABORT_KEY = "enrich:abort";
const TARGETS_KEY = "enrich:targets";
const TTL = 60 * 60;

let current: EnrichRun | null = null;

export function startEnrich(key: string, total: number, campaignName?: string): void {
  current = { key, campaignName, total, done: 0, found: 0, bySource: {}, running: true, aborted: false, startedAt: Date.now(), people: new Map() };
}

function person(name: string, publication?: string, authorId?: string): EnrichPerson {
  let p = current!.people.get(name);
  if (!p) { p = { name, authorId, publication, steps: [], status: "running", lastAt: Date.now() }; current!.people.set(name, p); }
  if (authorId && !p.authorId) p.authorId = authorId;
  return p;
}

export function enrichStep(name: string, detail: string, publication?: string, authorId?: string): void {
  if (!current) return;
  const p = person(name, publication, authorId);
  p.steps.push(detail);
  if (p.steps.length > MAX_STEPS) p.steps.shift();
  p.lastAt = Date.now();
}

export function enrichResult(entry: { name: string; authorId?: string; publication?: string; found: boolean; email?: string; source?: string; issues?: string[] }): void {
  if (!current) return;
  const p = person(entry.name, entry.publication, entry.authorId);
  const issues = entry.issues?.length ? entry.issues : undefined;
  p.status = entry.found ? "found" : (issues ? "error" : "not_found");
  p.email = entry.email;
  p.source = entry.source;
  p.issues = issues;
  p.lastAt = Date.now();
  current.done += 1;
  if (entry.found) {
    current.found += 1;
    if (entry.source) current.bySource[entry.source] = (current.bySource[entry.source] ?? 0) + 1;
  }
}

export function finishEnrich(): void {
  if (current) { current.running = false; current.finishedAt = Date.now(); }
}

export function abortEnrich(): void {
  if (current) current.aborted = true;
}

export function isEnrichAborted(): boolean {
  return current?.aborted ?? false;
}

export function isEnrichRunning(): boolean {
  return current?.running ?? false;
}

// In-memory snapshot (most-recent-active first, capped).
export function getEnrich(): (Omit<EnrichRun, "people"> & { people: EnrichPerson[] }) | null {
  if (!current) return null;
  const { people, ...rest } = current;
  const arr = [...people.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 200);
  return { ...rest, people: arr };
}

export function doneCount(): number {
  return current?.done ?? 0;
}

// ─── Redis mirror (durable across serverless instances) ─────────────────────────

// If a snapshot claims running=true but its heartbeat is older than this, the run's process
// died (recompile / function killed / crash) without finishing — treat it as NOT running so
// the UI stops showing a stuck run and a new run can start. The live loop snapshots every 2.5s.
const STALE_MS = 60_000;

export async function snapshotToRedis(): Promise<void> {
  const r = redis();
  const snap = getEnrich();
  if (!r || !snap) return;
  await r.set(SNAP_KEY, JSON.stringify({ ...snap, heartbeat: Date.now() }), { ex: TTL }).catch(() => {});
}

// Durable read for the status endpoint: prefer Redis (any instance), fall back to memory.
// A "running" snapshot with a stale heartbeat is reported as finished (orphaned run).
export async function getEnrichDurable(): Promise<(Omit<EnrichRun, "people"> & { people: EnrichPerson[] }) | null> {
  const r = redis();
  if (r) {
    const raw = await r.get<any>(SNAP_KEY).catch(() => null);
    if (raw) {
      const s = typeof raw === "string" ? JSON.parse(raw) : raw;
      // Orphaned if running but heartbeat is missing (old/dead writer) or stale (>60s).
      if (s.running && (typeof s.heartbeat !== "number" || Date.now() - s.heartbeat > STALE_MS)) {
        s.running = false;
      }
      return s;
    }
  }
  return getEnrich();
}

// Rebuild in-memory `current` from the Redis snapshot so a continuation chunk (fresh
// instance) resumes with the accumulated people/counters intact.
export async function restoreFromSnapshot(): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  const raw = await r.get<any>(SNAP_KEY).catch(() => null);
  if (!raw) return false;
  const s = typeof raw === "string" ? JSON.parse(raw) : raw;
  const people = new Map<string, EnrichPerson>();
  for (const p of s.people ?? []) people.set(p.name, p);
  current = {
    key: s.key, campaignName: s.campaignName, total: s.total ?? 0, done: s.done ?? 0,
    found: s.found ?? 0, bySource: s.bySource ?? {}, running: true, aborted: false,
    startedAt: s.startedAt ?? Date.now(), people,
  };
  return true;
}

export async function requestAbort(): Promise<void> {
  abortEnrich();
  const r = redis();
  if (r) await r.set(ABORT_KEY, "1", { ex: TTL }).catch(() => {});
}

export async function checkAbort(): Promise<boolean> {
  if (isEnrichAborted()) return true;
  const r = redis();
  // Upstash auto-deserializes "1" → 1, so compare loosely: any stored value = aborted.
  if (r) return !!(await r.get(ABORT_KEY).catch(() => null));
  return false;
}

async function clearAbort(): Promise<void> {
  const r = redis();
  if (r) await r.del(ABORT_KEY).catch(() => {});
}

// Is a run active anywhere? Durable so a second "start" on another instance is blocked.
export async function checkRunning(): Promise<boolean> {
  const snap = await getEnrichDurable();
  return snap?.running ?? false;
}

// The fixed target list is stored once at kickoff so continuation chunks resume the SAME
// list (recomputing would re-process not-found authors forever).
export async function setEnrichTargets(targets: unknown[]): Promise<void> {
  const r = redis();
  if (r) await r.set(TARGETS_KEY, JSON.stringify(targets), { ex: TTL }).catch(() => {});
}

export async function getEnrichTargets<T = unknown>(): Promise<T[] | null> {
  const r = redis();
  if (!r) return null;
  const raw = await r.get<any>(TARGETS_KEY).catch(() => null);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export async function clearEnrichTargets(): Promise<void> {
  const r = redis();
  if (r) await r.del(TARGETS_KEY).catch(() => {});
  await clearAbort();
}
