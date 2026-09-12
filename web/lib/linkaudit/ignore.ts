import { redis } from "@/lib/redis";

// Links the team has marked as false positives (e.g. bot-blocked hosts that always look
// "broken" but aren't). The crawler skips these so they never get checked or reported again,
// and existing findings for them are purged when they're ignored.
const KEY = "linkaudit:ignore";

export async function getIgnoredLinks(): Promise<string[]> {
  const r = redis();
  if (!r) return [];
  const raw = await r.get<any>(KEY).catch(() => null);
  if (!raw) return [];
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return []; }
}

export async function addIgnoredLink(url: string): Promise<void> {
  const r = redis();
  if (!r) throw new Error("Redis not configured — can't save the ignore list");
  const u = url.trim();
  if (!u) return;
  const list = await getIgnoredLinks();
  if (!list.includes(u)) { list.push(u); await r.set(KEY, JSON.stringify(list)); }
}

export async function removeIgnoredLink(url: string): Promise<void> {
  const r = redis();
  if (!r) return;
  await r.set(KEY, JSON.stringify((await getIgnoredLinks()).filter((x) => x !== url.trim())));
}
