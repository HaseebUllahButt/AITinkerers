import { redirect } from "next/navigation";

// Page Health merged into the unified Site Audit page (indexability / speed / page-types are
// categories there). Kept as a redirect so old bookmarks/links still land somewhere sensible.
export default function IndexingRedirect() {
  redirect("/site-audit");
}
