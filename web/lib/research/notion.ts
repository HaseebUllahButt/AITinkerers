// The Notion research backlog as a third source for Summer.
//
// The radar answers "what happened in the world". This answers "what did we already decide to write and
// never write" — often the better question, because somebody has already done the keyword research and
// made the call. It is also the source most likely to be stale, so every row is checked against what we
// have actually shipped before it is offered.
//
// ── Property names are DISCOVERED, never hardcoded ──────────────────────────────────────────────
//
// A hardcoded "Page Title" becomes zero rows the day somebody renames a column, and zero rows looks
// exactly like "nothing left to write" — an invisible failure that would quietly remove this source
// without anybody noticing it had gone. So the schema is read first and the properties are found by
// TYPE (there is exactly one title; a status is a status/select) and only then narrowed by name.
//
// ── Three dedupe gates, because the backlog does not know what we shipped ───────────────────────
//
//   1. Notion's own state — a status that reads as done, or the [DRAFTED] tag the template-launch
//      skill stamps when it claims a row.
//   2. SearchOps's own drafts — `blog_drafts`, so a piece somebody is mid-way through is not offered
//      again to a second person.
//   3. Strapi and the live sitemap, through ledgerCheck — the same corpus the landing radar dedupes
//      against. This is the one that matters: the backlog is months old in places and a good chunk of
//      it is already published.
//
// ── A shared-with-nobody integration is NOT an empty backlog ────────────────────────────────────
//
// Measured while building this: the token authenticates fine as "summit" and `search` returns zero
// objects, because a Notion integration sees only what somebody has explicitly connected to it. Both
// states return no rows, and reporting them the same way would have this source silently contribute
// nothing forever. `reason` distinguishes them and names the fix.
import { supabaseAdmin } from "@/lib/db/supabase";
import { ledgerCheck } from "@/lib/research/ledger";

const NOTION_VERSION = "2022-06-28";
/** The tag the template-launch skill writes when it claims a row. Honoured so the two agree. */
const CLAIMED_TAG = "DRAFTED";

export interface NotionRow {
  pageId: string;
  url: string;
  subject: string;
  /** Whatever the status column says, verbatim. */
  status: string;
  /** Free-text from a relevance/notes column, when there is one. */
  note: string;
  /**
   * Which of the page's databases this row came from, and what that database plans.
   *
   * The configured Notion page holds TWO databases — "Page List+KW research" (cluster/feature pages,
   * with a Template column of MCP/T7/T1/Ad Studio) and "Blog Clusters" (blog topics). This module read
   * only the first, so every subject it ever offered was a planned FEATURE PAGE, whoever asked and for
   * whatever purpose. Handing one of those to a blog writer produces precisely the collision the SEO
   * team reported: "It has feature page intent and I am already working on it. Both blog and feature
   * page would cannibalize."
   */
  kind: "page" | "blog";
  /** The database's own title, so a person can see which list a row came from. */
  source: string;
  /**
   * Who has their name on the row, and the landing-page template it is planned for ("" when absent).
   *
   * Read so a writer can be told BEFORE they start. An owner means it is somebody's current work; a
   * template means the plan is a landing page, and a blog on the same head term would compete with it.
   */
  owner: string;
  template: string;
  /**
   * Plain-English warning to show the writer, or null when there is nothing to say.
   *
   * Advisory on purpose. The person may have a good reason — a genuinely different long-tail angle, or
   * they ARE the owner — and a gate they cannot override is a gate they learn to route around.
   */
  cannibalisation: string | null;
  /** Why this row is still open, or why it was dropped. */
  verdict: "open" | "already-shipped" | "being-drafted" | "claimed";
  /** The evidence behind a non-open verdict, so the person can disagree with it. */
  evidence: string | null;
}

export interface NotionBacklog {
  rows: NotionRow[];
  /** Rows read before dedupe, so "12 of 40 still open" can be said. */
  scanned: number;
  /** Null when it worked. Otherwise a sentence naming the fix. */
  reason: string | null;
}

function headers(): Record<string, string> | null {
  const t = process.env.NOTION_TOKEN?.trim();
  if (!t) return null;
  return { Authorization: `Bearer ${t}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
}

export function notionConfigured(): boolean {
  return !!process.env.NOTION_TOKEN?.trim();
}

/** Plain text out of any property shape Notion might hand back. */
function plain(prop: unknown): string {
  const p = prop as Record<string, any> | null;
  if (!p) return "";
  if (Array.isArray(p.title)) return p.title.map((t: any) => t.plain_text).join("");
  if (Array.isArray(p.rich_text)) return p.rich_text.map((t: any) => t.plain_text).join("");
  if (p.select) return p.select.name ?? "";
  if (p.status) return p.status.name ?? "";
  if (Array.isArray(p.multi_select)) return p.multi_select.map((o: any) => o.name).join(", ");
  // `people` had no branch, so the Owner column read as "" on every row and the "somebody is already
  // working on this" half of the cannibalisation warning could never fire — the signal was present in
  // Notion and dropped here. Falls back to the id when a name is not shared: an unnamed owner is still
  // an owner, and "someone owns this" is the part that matters.
  if (Array.isArray(p.people)) return p.people.map((o: any) => o.name ?? o.id ?? "").filter(Boolean).join(", ");
  if (typeof p.url === "string") return p.url;
  if (typeof p.number === "number") return String(p.number);
  return "";
}

/** A status value that means "do not offer this again". */
function readsAsDone(status: string): boolean {
  return /done|complete|publish|live|shipped|drafted|written|archive/i.test(status);
}

/**
 * Find EVERY database to read, not just the first one.
 *
 * `NOTION_RESEARCH_PAGE_ID` is a page id, and that page holds two child databases:
 *
 *   Page List+KW research   Owner·Status·Relevance·Template·Date Published·Page Title   → feature pages
 *   Blog Clusters           owner·statu·Name                                            → blog topics
 *
 * This used to return the first `child_database` block it found and stop, so the blog list was
 * invisible and every subject offered came from the feature-page list. That is not a cosmetic
 * mislabel: those rows have owners and templates, and offering one as a blog subject sets up two URLs
 * competing for one intent.
 *
 * Kind is decided by the SHAPE, not the title, because titles get renamed: a database carrying a
 * template column is planning pages. The title is kept only to show a person which list a row is from.
 */
async function resolveDatabases(h: Record<string, string>): Promise<{ dbs: Array<{ id: string; title: string }>; reason: string | null }> {
  const configured = process.env.NOTION_RESEARCH_PAGE_ID?.trim();

  if (configured) {
    // Still allow the env var to point straight AT a database — that used to work and may elsewhere.
    const direct = await fetch(`https://api.notion.com/v1/databases/${configured}`, { headers: h });
    if (direct.ok) {
      const j = await direct.json();
      return { dbs: [{ id: configured, title: titleOf(j) }], reason: null };
    }

    // A page: walk ALL its children, paginated. Two databases sit side by side today and a third
    // would have been just as invisible as the second was.
    const found: Array<{ id: string; title: string }> = [];
    let cursor: string | undefined;
    do {
      const u = new URL(`https://api.notion.com/v1/blocks/${configured}/children`);
      u.searchParams.set("page_size", "100");
      if (cursor) u.searchParams.set("start_cursor", cursor);
      const kids = await fetch(u, { headers: h });
      if (!kids.ok) break;
      const j = await kids.json();
      for (const b of (j?.results ?? []) as any[]) {
        if (b.type === "child_database" && b.id) {
          found.push({ id: String(b.id), title: String(b.child_database?.title ?? "").trim() || "untitled" });
        }
      }
      cursor = j?.has_more ? j.next_cursor : undefined;
    } while (cursor);
    if (found.length) return { dbs: found, reason: null };
  }

  // Nothing reachable by id. Before giving up, ask what IS shared — the difference between "wrong id"
  // and "nothing shared with the integration" is the difference between two very different fixes.
  const search = await fetch("https://api.notion.com/v1/search", {
    method: "POST", headers: h,
    body: JSON.stringify({ filter: { property: "object", value: "database" }, page_size: 10 }),
  });
  if (search.ok) {
    const j = await search.json();
    const dbs = (j?.results ?? []) as Array<{ id: string; title?: Array<{ plain_text: string }> }>;
    if (dbs.length) {
      return { dbs: dbs.map((d) => ({ id: d.id, title: (d.title ?? []).map((t) => t.plain_text).join("") || "untitled" })), reason: null };
    }
  }

  return {
    dbs: [],
    reason:
      "The Notion token works, but NOTHING is shared with the integration — Notion only exposes pages a " +
      "person has connected. Open the research database in Notion, then ··· → Connections → add “summit”. " +
      "Until then this source has no rows to offer, which is not the same as the backlog being empty.",
  };
}

function titleOf(db: any): string {
  return ((db?.title ?? []) as Array<{ plain_text?: string }>).map((t) => t.plain_text ?? "").join("").trim() || "untitled";
}

/**
 * The properties that matter, found by TYPE first and name second.
 *
 * `owner` and `template` were not read at all, and their absence caused a real collision: this
 * database is literally called "Page List+KW research" and carries a `Template` column
 * (MCP / T7 / T1 / Ad Studio), which means every row in it is a planned FEATURE PAGE with a person's
 * name on it — not a free blog topic. Offering one as a blog subject invites exactly the thing the
 * SEO team called out: "It has feature page intent and I am already working on it. Both blog and
 * feature page would cannibalize."
 *
 * `status` is matched on type "status" BEFORE any "select", because a select is far more likely to be
 * something else (here, Template). The old condition took whichever of the two Notion happened to
 * return first and would have read the template name as the status.
 */
function findProps(db: any): { title: string | null; status: string | null; note: string | null; tags: string | null; owner: string | null; template: string | null } {
  let title: string | null = null, status: string | null = null, note: string | null = null, tags: string | null = null;
  let owner: string | null = null, template: string | null = null, firstSelect: string | null = null;
  for (const [name, def] of Object.entries<any>(db?.properties ?? {})) {
    if (def.type === "title") title = name;
    else if (def.type === "status" && !status) status = name;
    else if (def.type === "people" && !owner) owner = name;
    else if (def.type === "select") {
      // Name it if it says what it is; otherwise hold it as the status fallback.
      if (!template && /template|layout|type/i.test(name)) template = name;
      else if (!firstSelect) firstSelect = name;
    }
    else if (def.type === "multi_select" && !tags) tags = name;
    else if (def.type === "rich_text" && !note) note = name;
  }
  if (!status) status = firstSelect;          // no real status column — fall back as before
  if (!template && firstSelect && firstSelect !== status) template = firstSelect;
  return { title, status, note, tags, owner, template };
}

/**
 * What is still worth writing, from the backlog.
 *
 * Every gate is reported rather than silently applied: a row dropped as "already-shipped" carries the
 * page it matched, so a person who disagrees can see why and overrule it. A dedupe you cannot audit is
 * one people learn to distrust and work around.
 */
export async function notionBacklog(opts: { limit?: number } = {}): Promise<NotionBacklog> {
  const limit = Math.max(1, Math.min(opts.limit ?? 15, 50));
  const out: NotionBacklog = { rows: [], scanned: 0, reason: null };

  const h = headers();
  if (!h) return { ...out, reason: "NOTION_TOKEN is not set, so the research backlog cannot be read." };

  const { dbs, reason } = await resolveDatabases(h).catch((e) => ({ dbs: [] as Array<{ id: string; title: string }>, reason: String(e?.message ?? e) }));
  if (!dbs.length) return { ...out, reason };

  // SearchOps's own drafts, once, rather than per row.
  const { data: drafts } = await supabaseAdmin.from("blog_drafts").select("title").limit(1000);
  const draftTitles = (drafts ?? []).map((d) => String(d.title ?? "").toLowerCase()).filter(Boolean);

  const candidates: NotionRow[] = [];
  const readFailures: string[] = [];

  for (const database of dbs) {
    const dbRes = await fetch(`https://api.notion.com/v1/databases/${database.id}`, { headers: h });
    if (!dbRes.ok) { readFailures.push(`${database.title}: schema read returned ${dbRes.status}`); continue; }
    const db = await dbRes.json();
    const props = findProps(db);
    if (!props.title) { readFailures.push(`${database.title}: no title property, so its rows have no subject`); continue; }

    // SHAPE, not title: a database carrying a template column is planning pages. Titles get renamed.
    const kind: NotionRow["kind"] = props.template ? "page" : "blog";

    const q = await fetch(`https://api.notion.com/v1/databases/${database.id}/query`, {
      method: "POST", headers: h, body: JSON.stringify({ page_size: 100 }),
    });
    if (!q.ok) { readFailures.push(`${database.title}: query returned ${q.status}`); continue; }
    const qj = await q.json();
    const results = (qj?.results ?? []) as Array<Record<string, any>>;
    out.scanned += results.length;

    for (const page of results) {
      const p = page.properties ?? {};
      const subject = plain(p[props.title]).trim();
      if (!subject) continue;
      const status = props.status ? plain(p[props.status]) : "";
      const tagText = props.tags ? plain(p[props.tags]) : "";
      const owner = props.owner ? plain(p[props.owner]) : "";
      const template = props.template ? plain(p[props.template]) : "";

      let verdict: NotionRow["verdict"] = "open";
      let evidence: string | null = null;

      if (tagText.toUpperCase().includes(CLAIMED_TAG) || subject.toUpperCase().includes(`[${CLAIMED_TAG}]`)) {
        verdict = "claimed";
        evidence = "already claimed by a previous run";
      } else if (readsAsDone(status)) {
        verdict = "already-shipped";
        evidence = `Notion status: ${status}`;
      } else {
        const s = subject.toLowerCase();
        const hit = draftTitles.find((t) => t === s || (t.length > 12 && s.includes(t)) || (s.length > 12 && t.includes(s)));
        if (hit) { verdict = "being-drafted"; evidence = `a SearchOps draft already exists: “${hit.slice(0, 60)}”`; }
      }

      candidates.push({
        pageId: String(page.id),
        url: String(page.url ?? ""),
        subject,
        status: status || "(none)",
        note: props.note ? plain(p[props.note]).slice(0, 240) : "",
        kind, source: database.title,
        owner, template,
        // Assembled here so every surface says the same thing.
        cannibalisation: cannibalisationNote({ kind, owner, template, status, source: database.title }),
        verdict, evidence,
      });
    }
  }

  if (!candidates.length) {
    return {
      ...out,
      reason: readFailures.length
        ? `No rows could be read. ${readFailures.join("; ")}.`
        : "The Notion databases are reachable and have no rows.",
    };
  }
  // A partial read is reported and still returns what it got — one unreadable list must not hide the other.
  if (readFailures.length) out.reason = `Read ${dbs.length - readFailures.length} of ${dbs.length} lists. ${readFailures.join("; ")}.`;

  // A subject planned as a PAGE and also sitting in the blog list is the collision itself, so say so
  // on both rows rather than making someone notice the repetition.
  const pageSubjects = new Map(candidates.filter((c) => c.kind === "page").map((c) => [c.subject.toLowerCase(), c]));
  for (const c of candidates) {
    if (c.kind !== "blog") continue;
    const twin = pageSubjects.get(c.subject.toLowerCase());
    if (!twin) continue;
    c.cannibalisation =
      `“${twin.subject}” is ALSO in “${twin.source}” as a planned landing page`
      + `${twin.template ? ` (template ${twin.template})` : ""}${twin.owner ? `, owned by ${twin.owner}` : ""}. `
      + "Writing both would put two URLs against one intent. Pick one, or make the blog a genuinely "
      + "different long-tail angle that links to the page.";
  }

  // The Strapi + sitemap check runs ONLY on rows still open, and only up to the limit. It reads a
  // cached corpus, but scoring forty subjects nobody will be offered is work for nothing.
  const open = candidates.filter((c) => c.verdict === "open").slice(0, limit);
  for (const row of open) {
    const check = await ledgerCheck(row.subject).catch(() => null);
    if (!check) continue;
    if (check.verdict.verdict === "DUPLICATE") {
      row.verdict = "already-shipped";
      row.evidence = check.verdict.note || "the ledger found a page for it";
    } else if (check.verdict.verdict === "NEAR_DUPLICATE") {
      // Left OPEN deliberately, with the warning attached. A near-match is often a second angle worth
      // writing, and dropping it would hide the decision from the person entitled to make it.
      row.evidence = `close to something we have: ${check.verdict.note}`;
    }
  }

  out.rows = candidates.filter((c) => open.includes(c) || c.verdict !== "open");
  return out;
}

/**
 * What to tell a writer before they spend a day on a subject somebody else owns.
 *
 * Phrased as advice, never a refusal. The SEO team's own words for the failure it prevents: "It has
 * feature page intent and I am already working on it. Both blog and feature page would cannibalize."
 * Two URLs chasing one intent split the clicks and the internal links, and Google usually picks the
 * weaker one — so this is a ranking decision, not tidiness.
 *
 * Three independent signals, each worth saying on its own:
 *   kind=page → the row IS a planned landing page, so a blog on the same head term competes with it.
 *   owner     → a person is on it; talk to them before starting.
 *   template  → confirms the landing-page plan and which layout it is going into.
 */
function cannibalisationNote(r: { kind: NotionRow["kind"]; owner: string; template: string; status: string; source: string }): string | null {
  const bits: string[] = [];
  if (r.kind === "page") {
    bits.push(`this row is from “${r.source}”, which plans LANDING PAGES${r.template ? ` (template ${r.template})` : ""}`);
  }
  if (r.owner) bits.push(`${r.owner} has their name on it`);
  if (!bits.length) return null;
  const active = /progress|revamp|revise/i.test(r.status) ? `, status “${r.status}”` : "";
  const advice = r.kind === "page"
    ? "A blog on the same subject would compete with that page for one intent. Either take the landing "
      + "page itself, or pick a genuinely different long-tail angle that links TO the page rather than repeating it."
    : "Worth a word before starting, so two people are not writing the same thing.";
  return `${bits.join(", ")}${active}. ${advice}`;
}
