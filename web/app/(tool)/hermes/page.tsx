import { redirect } from "next/navigation";

// The agent moved to /summer when it was named. This redirect exists because the old path is in
// bookmarks, in Slack links and in at least one screenshot — a 404 for muscle memory is a worse
// outcome than one extra file. Delete it once nobody lands here.
export default function HermesRedirect() {
  redirect("/summer");
}
