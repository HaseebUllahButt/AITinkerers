import { webSearch } from "@/lib/search/webSearch";

// Find a person's LinkedIn profile via a real search API (Tavily/Google/Brave/Serper —
// whichever key is set). Only accepts a result whose /in/ slug plausibly matches the
// person's name, so a wrong-person profile never gets fed to Blitz.

const LINKEDIN_IN_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]+/gi;

function nameTokens(name: string): string[] {
  return name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ").split(/\s+/).filter((t) => t.length >= 3);
}

function slugMatchesName(url: string, name: string): boolean {
  const slug = url.toLowerCase().split("/in/")[1] ?? "";
  return nameTokens(name).some((t) => slug.includes(t));
}

export async function findLinkedinUrl(name: string, company: string, signal?: AbortSignal, onError?: (msg: string) => void): Promise<string | null> {
  const hits = await webSearch(`${name} ${company} linkedin`, 8, signal, onError);
  for (const h of hits) {
    // The LinkedIn URL may be the result URL itself or appear in its snippet.
    for (const text of [h.url, h.snippet]) {
      for (const m of text.matchAll(LINKEDIN_IN_RE)) {
        const url = m[0].replace(/\/$/, "");
        if (slugMatchesName(url, name)) return url;
      }
    }
  }
  return null;
}
