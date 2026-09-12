// Outbound text: chunked to WhatsApp's limit, paced so a burst doesn't read as spam, and queued
// to disk while the socket is down — an audit post that arrives during a reconnect must not
// silently vanish.
import { mkdir, readdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { OUTBOX_DIR, TIMING } from './config.js'

const MAX_TEXT = 3900

let sock = null
let draining = false
const pending = []

export function attachSocket(s) {
  sock = s
}

function chunk(text) {
  const chunks = []
  let current = ''
  for (const line of String(text).split('\n')) {
    if (current.length + line.length + 1 > MAX_TEXT) {
      if (current) chunks.push(current)
      let rest = line
      while (rest.length > MAX_TEXT) {
        chunks.push(rest.slice(0, MAX_TEXT))
        rest = rest.slice(MAX_TEXT)
      }
      current = rest
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }
  if (current) chunks.push(current)
  return chunks
}

async function persist(jid, text) {
  await mkdir(OUTBOX_DIR, { recursive: true })
  const name = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  await writeFile(join(OUTBOX_DIR, name), JSON.stringify({ jid, text, at: Date.now() }))
}

/** Send now, or queue to disk when the socket is down. Always resolves — /send should not 500
 *  because WhatsApp is mid-reconnect. */
export async function send(jid, text) {
  if (!sock) {
    await persist(jid, text)
    return { queued: true }
  }
  pending.push({ jid, text })
  if (!draining) void drain()
  return { queued: false }
}

async function drain() {
  draining = true
  try {
    while (pending.length && sock) {
      const { jid, text } = pending.shift()
      for (const part of chunk(text)) {
        await sock.sendMessage(jid, { text: part })
        await new Promise((r) => setTimeout(r, TIMING.sendGapMs))
      }
    }
  } finally {
    draining = false
  }
}

/** Replays anything that was persisted while the socket was down. Called on connection open. */
export async function flush(currentSock) {
  sock = currentSock
  let files = []
  try {
    files = await readdir(OUTBOX_DIR)
  } catch {
    return
  }
  for (const name of files) {
    if (!name.endsWith('.json')) continue
    const path = join(OUTBOX_DIR, name)
    try {
      const rec = JSON.parse(await readFile(path, 'utf8'))
      for (const part of chunk(rec.text)) {
        await sock.sendMessage(rec.jid, { text: part })
        await new Promise((r) => setTimeout(r, TIMING.sendGapMs))
      }
      await unlink(path).catch(() => {})
    } catch (err) {
      console.log('[bridge] outbox entry failed:', name, err?.message || err)
    }
  }
}
