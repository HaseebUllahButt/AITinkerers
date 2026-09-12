// Recent audits, kept in the browser.
//
// There is no server-side store, so this is deliberately per-viewer: it survives reloads, does not
// sync anywhere, and is never presented as shared history. Every accessor is wrapped, because
// localStorage throws in a private window and comes back empty after a site-data clear — a
// dashboard that crashes on a storage quirk is worse than one showing an empty list.
export interface AuditRecord {
  url: string;
  domain: string;
  brand: string;
  score: number;
  criticals: number;
  /** ISO timestamp. */
  at: string;
}

const KEY = "searchops.audits.v1";
const LIMIT = 12;

export function loadHistory(): AuditRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is AuditRecord =>
        r && typeof r.url === "string" && typeof r.domain === "string" && typeof r.score === "number",
    );
  } catch {
    return [];
  }
}

export function recordAudit(entry: AuditRecord): void {
  if (typeof window === "undefined") return;
  try {
    // One row per domain: re-auditing a site should update its entry, not stack duplicates.
    const next = [entry, ...loadHistory().filter((r) => r.domain !== entry.domain)].slice(0, LIMIT);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — the audit itself is unaffected */
  }
}

export function clearHistory(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}
