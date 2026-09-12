// WhatsApp bridge — holds the Baileys (WhatsApp Web) socket as a long-lived process and
// translates it to plain HTTP for the Next.js app, which cannot hold a socket itself.
//
//   inbound:  whatsapp → this socket → POST APP_URL/api/whatsapp/events (Bearer secret)
//   outbound: app POSTs /send (Bearer secret) → sendMessage
//   pairing:  GET /qr → PNG to scan; creds persist in ./creds so pairing survives restarts
//
// Env (in web/.env.local or the process env):
//   WHATSAPP_BRIDGE_SECRET   shared secret — the only auth on both hops. Required.
//   WHATSAPP_BRIDGE_PORT     default 8788
//   APP_URL                  where the Next app lives — default http://localhost:3000
//   WA_CREDS_DIR             where the linked-device session persists — default ./creds
import { APP_URL, SECRET } from './src/config.js'
import { start } from './src/connection.js'
import { startServer } from './src/server.js'

if (!SECRET) {
  console.error('[bridge] WHATSAPP_BRIDGE_SECRET is not set — refusing to run unauthenticated.')
  process.exit(1)
}

async function forwardToApp(event) {
  const res = await fetch(`${APP_URL}/api/whatsapp/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => {
    console.log('[bridge] app unreachable:', e?.message || e)
    return null
  })
  if (res && !res.ok) console.log('[bridge] app rejected event:', res.status)
}

async function main() {
  startServer()
  await start(forwardToApp)
}

main().catch((err) => {
  console.error('[bridge] start failed:', err?.stack || err?.message)
  setTimeout(() => {
    main().catch((retryErr) => {
      console.error('[bridge] retry failed:', retryErr?.message)
      process.exit(1)
    })
  }, 10_000)
})
