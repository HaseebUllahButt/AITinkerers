// Baileys socket lifecycle, adapted from Sangi's connection.js: multi-file auth state, QR capture
// for pairing, exponential-backoff reconnect, and a hard stop on loggedOut (which means re-pair —
// reconnecting would loop forever against an unlinked account).
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'
import { mkdir } from 'node:fs/promises'
import { CREDS_DIR, TIMING } from './config.js'
import { isBroadcast, userPart } from './jid.js'
import { flush } from './send.js'

let sock = null
let selfJid = null
let selfNumber = null
let latestQr = null
let reconnectTimer = null
let attempt = 0
let onMessage = null

export function status() {
  return { connected: !!sock && !!selfJid, self: selfNumber, paired: !!selfJid }
}

export function currentQr() {
  return latestQr
}

function scheduleReconnect(reason) {
  if (reconnectTimer) return
  attempt += 1
  const capped = Math.min(TIMING.reconnectBaseMs * 2 ** (attempt - 1), TIMING.reconnectMaxMs)
  const delay = Math.round(capped * (0.5 + Math.random() / 2))
  console.log(`[bridge] reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}, ${reason})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    start(onMessage).catch((err) => scheduleReconnect(`start failed: ${err.message}`))
  }, delay)
}

// Our own account's other devices stream sync traffic we can never decrypt after a re-pair, and
// every failure triggers a retry receipt that the server answers with another copy — a loop that
// never converges. Ignoring fromMe outright is cheaper than decrypting then discarding.
function shouldIgnoreJid(jid) {
  if (!jid) return false
  if (isBroadcast(jid)) return true
  return false
}

export async function start(messageHandler) {
  onMessage = messageHandler
  if (sock) {
    try { sock.ev.removeAllListeners() } catch {}
    try { sock.end(undefined) } catch {}
    sock = null
  }

  await mkdir(CREDS_DIR, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(CREDS_DIR)
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: true,
    syncFullHistory: false,
    browser: ['Mac OS', 'Chrome', '14.4.1'],
    shouldIgnoreJid,
    maxMsgRetryCount: 2,
    retryRequestDelayMs: 2000,
    defaultQueryTimeoutMs: 90_000,
    keepAliveIntervalMs: 25_000,
    connectTimeoutMs: 45_000,
    getMessage: async () => undefined,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) latestQr = qr
    if (connection === 'open') {
      latestQr = null
      selfJid = sock.user?.id ?? null
      selfNumber = selfJid ? selfJid.split('@')[0].split(':')[0] : null
      attempt = 0
      console.log('[bridge] connected as', selfJid)
      flush(sock).catch((err) => console.log('[bridge] outbox flush error:', err.message))
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        console.log('[bridge] logged out — delete', CREDS_DIR, 'and re-pair')
        return
      }
      scheduleReconnect(`close code ${code}`)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !onMessage) return
    for (const msg of messages) {
      if (!msg?.message || msg.key?.fromMe) continue
      const text = msg.message.conversation
        ?? msg.message.extendedTextMessage?.text
        ?? msg.message.imageMessage?.caption
        ?? ''
      if (!text.trim()) continue
      try {
        await onMessage({
          self: selfNumber,
          chat: msg.key.remoteJid,
          from: msg.key.participant ? userPart(msg.key.participant) : userPart(msg.key.remoteJid),
          pushName: msg.pushName ?? '',
          text: text.trim(),
        })
      } catch (err) {
        console.log('[bridge] inbound forward failed:', err?.message || err)
      }
    }
  })

  return sock
}

export function socket() {
  return sock
}
