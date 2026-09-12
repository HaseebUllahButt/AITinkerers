import { inferTimezone } from "@/lib/email/timezones";
import { llmChat, llmEnabled } from "@/lib/providers/llm";

export interface TzCandidate {
  authorId: string;
  name: string;
  publication?: string;
  host?: string;
  country?: string;
  bio?: string;
}

// Valid IANA-ish check so the LLM can't hand us garbage that Intl will throw on.
function isValidTz(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; }
  catch { return false; }
}

// Resolve each author's IANA timezone. Fast path: country-code TLD / explicit country
// (free, deterministic). Everything left over — the .com / neutral-TLD majority — goes to
// the LLM in batches, guessing from the writer's name + publication. Returns authorId → tz.
export async function inferTimezones(candidates: TzCandidate[], fallback: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const needLLM: TzCandidate[] = [];

  for (const c of candidates) {
    const fromTld = inferTimezone(c.host, c.country, "");
    if (fromTld) out[c.authorId] = fromTld; // TLD/country gave a real signal
    else needLLM.push(c);
  }

  if (needLLM.length === 0 || !llmEnabled()) {
    for (const c of needLLM) out[c.authorId] = fallback;
    return out;
  }

  const BATCH = 25;
  for (let i = 0; i < needLLM.length; i += BATCH) {
    const batch = needLLM.slice(i, i + BATCH);
    try {
      const guessed = await guessBatch(batch);
      for (const c of batch) {
        const g = guessed[c.authorId];
        out[c.authorId] = g && isValidTz(g) ? g : fallback;
      }
    } catch {
      for (const c of batch) out[c.authorId] = fallback;
    }
  }

  return out;
}

async function guessBatch(batch: TzCandidate[]): Promise<Record<string, string>> {
  const list = batch.map((c, i) =>
    `${i}. writer="${c.name}" publication="${c.publication ?? c.host ?? "unknown"}"${c.bio ? ` bio="${c.bio.slice(0, 120)}"` : ""}`
  ).join("\n");

  const prompt = `For each writer below, give the single most likely IANA timezone they work in, based on their publication and name. Publications are usually tied to a country/region (e.g. TechCrunch→America/Los_Angeles, The Guardian→Europe/London, YourStory→Asia/Kolkata, Gizmodo Australia→Australia/Sydney). If genuinely unsure, use America/New_York.

Writers:
${list}

Reply ONLY with a JSON object mapping each number to an IANA timezone string, e.g. {"0":"America/Los_Angeles","1":"Europe/London"}. No prose.`;

  // No `temperature`, no `maxTokens`, no `timeoutMs` — all three were Haiku-shaped and become
  // silent traps on an Opus-class default. temperature:0 is a 400 on the frontier models, so the
  // determinism we had here is gone deliberately (a 400 costs the whole batch, which is worse).
  // max_tokens:900 sized the JSON map alone; on a reasoning model thinking eats the same budget,
  // so the object comes back truncated and JSON.parse throws. 25s aborts a turn that thinks first.
  // Every one of those failures returns null below and reads as "no guess" → silent fallback tz.
  const res = await llmChat({ prompt });
  // llmChat swallows non-2xx / timeouts and returns null. An empty map lands every author in this
  // batch on `fallback` in the caller, exactly as the old `throw` → catch path did.
  if (!res) return {};
  const text: string = res.content ?? "";
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json) as Record<string, string>;

  // Map index → authorId
  const result: Record<string, string> = {};
  batch.forEach((c, i) => {
    const tz = parsed[String(i)];
    if (tz) result[c.authorId] = tz;
  });
  return result;
}
