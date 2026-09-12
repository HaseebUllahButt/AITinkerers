// Plain-English step descriptions for the writer's tool calls.
//
// A leaf module on purpose: both the live stream (agent.ts) and the rehydrated transcript
// (api/blog/writer/[id]/route.ts) need this, and importing it from agent.ts would drag the Anthropic
// SDK, the tool layer and the db into a plain GET route. Nothing here touches the network or the
// database, so it is also directly runnable from a script.

/**
 * Plain-English descriptions of what a tool call is doing, with the specific input echoed.
 *
 * Shared by the live stream and the rehydrated transcript so a turn reads identically whether you
 * watched it happen or reloaded the page afterwards. Eight identical "Wrote a section" lines told the
 * user nothing about progress; "Wrote “How much does it cost?” · 320 words" tells them where it is.
 */
export function describeToolCall(
  name: string,
  input: Record<string, unknown>,
  outlineSections: Array<{ heading: string }> = [],
): { label: string; detail?: string } {
  const q = (v: unknown) => (v ? `“${String(v)}”` : undefined);
  switch (name) {
    case "web_search":
      return { label: "Searching the web", detail: q(input.query) };
    case "serp_analysis":
      return { label: "Checking who ranks on Google", detail: q(input.keyword) };
    case "fetch_page":
      return { label: "Reading a source", detail: String(input.url ?? "") };
    case "competitor_page":
      return { label: "Analysing a competing page", detail: String(input.url ?? "") };
    case "keyword_data":
      return { label: "Pulling Search Console data", detail: q(input.keyword) };
    case "save_brief":
      return { label: "Saved the brief", detail: q(input.primary_keyword) };
    case "propose_outline": {
      const n = Array.isArray(input.sections) ? input.sections.length : 0;
      const s = Array.isArray(input.source_plan) ? input.source_plan.length : 0;
      const l = Array.isArray(input.link_plan) ? input.link_plan.length : 0;
      return { label: "Proposed the outline", detail: `${n} sections · ${s} sources · ${l} internal links` };
    }
    case "submit_section": {
      const i = Number(input.index);
      const heading = outlineSections[i]?.heading;
      const words = String(input.markdown ?? "").trim().split(/\s+/).filter(Boolean).length;
      return {
        label: heading ? `Wrote “${heading}”` : `Wrote section ${Number.isFinite(i) ? i + 1 : "?"}`,
        detail: `${words.toLocaleString()} words`,
      };
    }
    default:
      return { label: name };
  }
}
