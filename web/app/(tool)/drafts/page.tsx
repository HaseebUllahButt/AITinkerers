import { DraftsShell } from "./DraftsShell";

// /drafts — the list with nothing selected. The shell is shared with /drafts/[id]; see that route
// for why every draft is addressable.
export default function DraftsPage() {
  return <DraftsShell />;
}
