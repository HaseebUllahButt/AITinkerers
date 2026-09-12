// Which AI assistant sent us a real human.
//
// The other half of Agent Analytics, and the more valuable half. A crawler hit says a model CAN read
// us; a referral says a person read the answer and clicked through. The second is the only number here
// that connects to revenue, and it is the metric one school of GEO research argues should replace
// prompt-panel tracking entirely — because every real visitor phrases their question their own way, a
// referral count integrates over natural phrasing by construction, where a fixed prompt panel only
// ever measures the phrasings we happened to guess.
//
// Nothing exotic: when someone clicks a link inside ChatGPT, the browser sends `Referer:
// https://chatgpt.com/...`, exactly as it does arriving from Google or Reddit. This is data our site
// already receives and nobody has grouped.

export interface AiReferrer {
  engine: string;
  label: string;
  /** Hostnames, matched on the referrer's host (suffix match, so subdomains count). */
  hosts: string[];
}

export const AI_REFERRERS: AiReferrer[] = [
  { engine: "chatgpt", label: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com", "openai.com"] },
  { engine: "perplexity", label: "Perplexity", hosts: ["perplexity.ai"] },
  { engine: "claude", label: "Claude", hosts: ["claude.ai", "claude.com"] },
  { engine: "gemini", label: "Gemini", hosts: ["gemini.google.com", "bard.google.com"] },
  { engine: "copilot", label: "Copilot", hosts: ["copilot.microsoft.com", "bing.com/chat"] },
  { engine: "grok", label: "Grok", hosts: ["grok.com", "x.ai"] },
  { engine: "meta-ai", label: "Meta AI", hosts: ["meta.ai"] },
  { engine: "deepseek", label: "DeepSeek", hosts: ["chat.deepseek.com"] },
  { engine: "mistral", label: "Le Chat", hosts: ["chat.mistral.ai"] },
];

/**
 * Which AI assistant does this referrer belong to?
 *
 * Returns null for everything else — Google organic, direct, social. Deliberately NOT a catch-all
 * "other AI" bucket: a bucket like that fills up with things nobody can act on and then gets quoted as
 * if it meant something.
 */
export function identifyReferrer(referrer: string | null | undefined): AiReferrer | null {
  if (!referrer) return null;
  let host: string;
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    // Some log formats give a bare host rather than a URL.
    host = String(referrer).toLowerCase().replace(/^www\./, "").split("/")[0];
  }
  if (!host) return null;
  return AI_REFERRERS.find((r) =>
    r.hosts.some((h) => host === h || host.endsWith(`.${h}`) || h.includes("/") === false && host === h),
  ) ?? null;
}
