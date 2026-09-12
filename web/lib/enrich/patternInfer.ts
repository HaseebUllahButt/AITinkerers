// Infer a domain's email pattern from emails we ALREADY have, then apply it to the
// rest of that domain's authors — completely free, no API calls or credits. E.g. once
// we know natalie.brooks@ibm.com + john.granger@ibm.com, we know IBM uses {first}.{last}
// and can fill in every other IBM author for nothing.

import { registrableDomain } from "@/lib/util/domain";

const SUFFIXES = new Set(["phd", "jr", "sr", "ii", "iii", "iv", "md", "dr", "mr", "ms", "mrs", "prof"]);

function tokens(fullName: string): string[] {
  return fullName.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/g, " ")
    .split(/\s+/).filter((t) => t && !SUFFIXES.has(t));
}

// Named patterns: name parts → local part.
const PATTERNS: Record<string, (f: string, l: string) => string> = {
  "first.last": (f, l) => `${f}.${l}`,
  "first_last": (f, l) => `${f}_${l}`,
  "firstlast": (f, l) => `${f}${l}`,
  "flast": (f, l) => `${f[0]}${l}`,
  "f.last": (f, l) => `${f[0]}.${l}`,
  "first": (f) => f,
  "last": (f, l) => l,
  "lastfirst": (f, l) => `${l}${f}`,
  "first.l": (f, l) => `${f}.${l[0]}`,
  "firstl": (f, l) => `${f}${l[0]}`,
};

export interface DomainPattern {
  key: string;
  agree: number;   // how many known emails matched this pattern
  total: number;   // total known emails considered
  format: (fullName: string) => string | null;
}

// Hardcoded fallbacks for well-known publications where we may not always have ≥2
// sourced emails in the DB to infer from. Confirmed from real data (e.g. Fast Company:
// jmattson, hmccracken, apeters, mchavez → flast). Used ONLY when data inference fails,
// so a real inferred pattern always wins over this map.
const KNOWN_PATTERNS: Record<string, string> = {
  "fastcompany.com": "flast",
  "ibm.com": "flast",
};

function patternFromKey(key: string): DomainPattern | null {
  const fn = PATTERNS[key];
  if (!fn) return null;
  return {
    key,
    agree: 0,
    total: 0,
    format: (fullName: string) => {
      const t = tokens(fullName);
      if (t.length < 2) return null;
      try { return fn(t[0], t[t.length - 1]); } catch { return null; }
    },
  };
}

/** Map Hunter's pattern grammar onto our named patterns. Hunter reports what a domain actually
 *  uses ("{first}.{last}") from its own index — better evidence than inferring from whatever
 *  addresses we happen to hold — but it was logged and thrown away for months. Pure; null when
 *  Hunter names a shape we cannot generate. */
const HUNTER_TO_KEY: Record<string, string> = {
  "{first}.{last}": "first.last",
  "{first}_{last}": "first_last",
  "{first}{last}": "firstlast",
  "{f}{last}": "flast",
  "{f}.{last}": "f.last",
  "{first}": "first",
  "{last}": "last",
  "{last}{first}": "lastfirst",
  "{first}.{l}": "first.l",
  "{first}{l}": "firstl",
};

export function patternFromHunter(pattern: string | null | undefined): DomainPattern | null {
  if (!pattern) return null;
  const key = HUNTER_TO_KEY[pattern.trim().toLowerCase()];
  return key ? patternFromKey(key) : null;
}

// Resolve a domain's pattern: prefer one inferred from real emails; fall back to a
// hardcoded known pattern for major publications. `known` should already be filtered
// to emails AT this domain (see getKnownEmailsByDomain).
export function resolveDomainPattern(host: string, known: Array<{ name: string; email: string }>): DomainPattern | null {
  const inferred = detectPattern(known);
  if (inferred) return inferred;
  const knownKey = KNOWN_PATTERNS[registrableDomain(host)];
  return knownKey ? patternFromKey(knownKey) : null;
}

// Detect the dominant pattern. Requires at least `minAgree` known emails matching the
// same pattern AND that pattern covering a majority — otherwise returns null (too risky).
export function detectPattern(known: Array<{ name: string; email: string }>, minAgree = 2): DomainPattern | null {
  const tally: Record<string, number> = {};
  let considered = 0;

  for (const { name, email } of known) {
    const local = email.split("@")[0]?.toLowerCase();
    const t = tokens(name);
    if (!local || t.length < 2) continue;
    considered++;
    const first = t[0], last = t[t.length - 1];
    for (const [key, fn] of Object.entries(PATTERNS)) {
      try { if (fn(first, last) === local) tally[key] = (tally[key] ?? 0) + 1; } catch { /* skip */ }
    }
  }

  if (considered === 0) return null;
  const [bestKey, bestCount] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  if (!bestKey || bestCount < minAgree || bestCount / considered < 0.6) return null;

  const fn = PATTERNS[bestKey];
  return {
    key: bestKey,
    agree: bestCount,
    total: considered,
    format: (fullName: string) => {
      const t = tokens(fullName);
      if (t.length < 2) return null;
      return fn(t[0], t[t.length - 1]);
    },
  };
}
