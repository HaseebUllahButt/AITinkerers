// The mass-identical-body guard's pure core, kept out of the route file (routes may only export
// handlers) so a probe can assert it without a server.
//
// What it exists to catch, measured: on 2026-08-11 fourteen initials left one workflow with the
// SAME body — only the greeting line differed ("Hi Lucas," … "Hi Content Marketing Institute,") —
// six of them to one publication. Every recipient of a blast like that can see it is a blast, the
// reply rate was zero, and identical bulk mail is also what spam filters key on. The guard lets a
// template-shaped campaign send a few identical bodies (tests, tiny hand-runs) and refuses the
// Nth, with an error that says how to proceed. Grounded pitches pass by construction: their
// opener paragraph differs per article, so their normalized bodies are never equal.

/** How many sends of one exact (normalized) body per workflow are allowed before the next one is
 *  refused. Four absorbs legitimate small identical runs; the historical blast hit fourteen. */
export const IDENTICAL_BODY_LIMIT = 4;

/** Collapse a body to the form two "different" blast emails share: greeting line dropped (it is
 *  the one line a mass blast varies), case folded, whitespace collapsed. Empty in → empty out. */
export function normalizeBodyForDedup(body: string | null | undefined): string {
  const lines = (body ?? "").split("\n");
  const start = lines.findIndex((l) => l.trim().length > 0);
  if (start < 0) return "";
  const rest = /^\s*(hi|hey|hello|dear)\b/i.test(lines[start]) ? lines.slice(start + 1) : lines.slice(start);
  return rest.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
}
