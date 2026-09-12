// WhatsApp outbound — via the bridge service (services/whatsapp-bridge), which holds the Baileys
// socket. The app never touches WhatsApp directly: it POSTs {chat, text} to the bridge, and the
// bridge's shared secret is the only auth — the bridge is bound to localhost/next to the app, so
// the secret is what stops a stray process on the box from sending as the account.
export async function sendWhatsApp(
  chatJid: string, text: string,
): Promise<{ ok: boolean; error?: string }> {
  const base = process.env.WHATSAPP_BRIDGE_URL?.trim();
  const secret = process.env.WHATSAPP_BRIDGE_SECRET?.trim();
  if (!base || !secret) return { ok: false, error: "bridge_not_configured" };
  const res = await fetch(`${base.replace(/\/$/, "")}/send`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ chat: chatJid, text }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res?.ok) return { ok: false, error: `bridge ${res?.status ?? "unreachable"}` };
  return { ok: true };
}
