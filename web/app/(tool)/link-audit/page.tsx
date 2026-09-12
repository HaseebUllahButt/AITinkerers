import { redirect } from "next/navigation";

// Link Audit merged into the unified Site Audit page (broken links are now a category there).
// Kept as a redirect so old bookmarks/links still land somewhere sensible.
export default function LinkAuditRedirect() {
  redirect("/site-audit");
}
