import { redis } from "@/lib/redis";

// In-process controller (same-instance abort) + a durable Redis flag so a Stop request on
// ANY serverless instance halts a run executing on another. The running pipeline polls
// isStopRequested() and aborts its local controller when the flag is set.
let active: AbortController | null = null;
const ABORT_KEY = "pipeline:abort";

export function createPipelineController(): AbortController {
  if (active && !active.signal.aborted) active.abort("new run");
  active = new AbortController();
  return active;
}

export function stopPipeline(): boolean {
  if (active && !active.signal.aborted) active.abort("user stopped");
  return true; // durable flag handles the cross-instance case even without a local controller
}

export function isPipelineRunning(): boolean {
  return !!active && !active.signal.aborted;
}

export async function requestStop(): Promise<void> {
  stopPipeline();
  const r = redis();
  if (r) await r.set(ABORT_KEY, "1", { ex: 3600 }).catch(() => {});
}

export async function isStopRequested(): Promise<boolean> {
  const r = redis();
  if (!r) return false;
  return !!(await r.get(ABORT_KEY).catch(() => null));
}

export async function clearStop(): Promise<void> {
  const r = redis();
  if (r) await r.del(ABORT_KEY).catch(() => {});
}
