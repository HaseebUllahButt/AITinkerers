import { redirect } from "next/navigation";

// The drafts list lives at /drafts now — "All Content" was never a blog, it is every draft in the
// tool including landing-page copy and externally-triggered pieces.
//
// Kept as a redirect rather than deleted: /blog is in bookmarks, in Slack digests, in the usage
// tracker's route list, and is linked from /blog/writer. The child routes are
// unmoved, so /blog/writer and friends are unaffected.
export default function BlogListRedirect() {
  redirect("/drafts");
}
