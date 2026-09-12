// /summer/<sessionId> — one chat, one URL.
//
// The page itself is the same component /summer renders; this route only decides which chat it opens
// with. That is deliberate: a separate implementation would drift, and the rail already switches chats
// without navigating, so there is nothing here worth duplicating.
//
// Why it exists at all: a chat with no address cannot be linked, cannot be reopened from a
// notification, and cannot be shared with the person who asked about it. The attention banner's "open
// that chat" needs somewhere to point.
import HermesPage from "../page";

export default async function SummerSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <HermesPage initialSessionId={id} />;
}
