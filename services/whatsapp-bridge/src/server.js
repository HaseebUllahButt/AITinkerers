// The bridge's HTTP face. The app talks to exactly three endpoints:
//   GET  /status — is the socket up, and which number is it?
//   GET  /qr     — the current pairing QR as a PNG (scan once with the phone, then this 404s)
//   POST /send   — {chat, text} outbound, Bearer-authed with the shared secret
// Inbound goes the other way: connection.js forwards messages to APP_URL/api/whatsapp/events.
import { createServer } from 'node:http'
import { PORT, SECRET } from './config.js'
import { status, currentQr } from './connection.js'
import { send } from './send.js'

function authorized(req) {
  return SECRET && req.headers.authorization === `Bearer ${SECRET}`
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => { try { resolve(JSON.parse(raw)) } catch { resolve({}) } })
  })
}

export function startServer() {
  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
    res.setHeader('content-type', 'application/json')

    if (url.pathname === '/status') {
      res.end(JSON.stringify(status()))
      return
    }

    if (url.pathname === '/qr') {
      const qr = currentQr()
      if (!qr) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'paired or no qr pending' }))
        return
      }
      const { default: QRCode } = await import('qrcode')
      res.setHeader('content-type', 'image/png')
      res.end(await QRCode.toBuffer(qr, { scale: 6 }))
      return
    }

    if (url.pathname === '/send' && req.method === 'POST') {
      if (!authorized(req)) {
        res.statusCode = 401
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const body = await readBody(req)
      const chat = String(body.chat ?? '')
      const text = String(body.text ?? '')
      if (!chat || !text) {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'chat and text are required' }))
        return
      }
      const out = await send(chat, text).catch((e) => ({ error: e?.message }))
      res.statusCode = out?.error ? 502 : 200
      res.end(JSON.stringify(out ?? { ok: true }))
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ error: 'not found' }))
  }).listen(PORT, () => console.log('[bridge] http on :' + PORT))
}
