import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// The Baileys auth state lives here between restarts — deleting it re-pairs the device.
export const CREDS_DIR = process.env.WA_CREDS_DIR || join(ROOT, 'creds')
export const OUTBOX_DIR = join(ROOT, 'outbox')

export const PORT = Number(process.env.WA_BRIDGE_PORT || 8791)

// Where the app lives, for inbound forwarding. The shared secret is the only auth in both
// directions: app → bridge on /send, bridge → app on /api/whatsapp/events.
export const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '')
export const SECRET = process.env.WHATSAPP_BRIDGE_SECRET || ''

export const TIMING = {
  reconnectBaseMs: 1000,
  reconnectMaxMs: 60_000,
  // WhatsApp paces what it tolerates; ~1.2s between sends is the rate that kept Sangi's number
  // unbanned. The queue drains at this rate, not all at once.
  sendGapMs: 1200,
}
