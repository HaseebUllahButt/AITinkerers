import { DraftsShell } from "../DraftsShell";

// /drafts/<id> — the same shell, opened on one draft.
//
// Every draft is addressable because the alternative is what Slack notifications were doing:
// linking at /drafts and telling six people to find the right row themselves. A notification that
// names a draft should open THAT draft.
//
// The shell is a client component and the list is fetched there, so this route adds no data
// loading of its own — it only passes the id through. An id that does not exist surfaces as the
// shell's own "couldn't open that draft" toast rather than a 404, which is the honest outcome for a
// draft that was deleted after the link was sent.
export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DraftsShell initialDraftId={id} />;
}
