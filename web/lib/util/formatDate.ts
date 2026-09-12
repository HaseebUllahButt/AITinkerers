// Short human timestamp — "Jul 24, 03:15 PM". Shared by the Site Audit panels (was copy-pasted
// in the old link-audit and indexing pages).
export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "—";
  }
}
