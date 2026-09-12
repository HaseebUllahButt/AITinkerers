# WhatsApp bridge

Holds the WhatsApp socket for SearchOps. The Next.js app cannot keep a persistent
connection — Baileys is a WhatsApp Web client that must run as a long-lived process —
so this small service owns the socket and exposes plain HTTP in both directions:

```
inbound:   whatsapp → this socket → POST $APP_URL/api/whatsapp/events  (Bearer secret)
outbound:  app POSTs /send        → sendMessage                        (Bearer secret)
pairing:   GET /qr   → PNG to scan once with the phone
status:    GET /status → { connected, self, paired }
```

Adapted from the connection handling in Sangi (`~/dev/me/hehe/Sangi`), the same
Baileys stack already proven on this machine.

## Run

```bash
cd services/whatsapp-bridge
npm install
WHATSAPP_BRIDGE_SECRET=<same value as web/.env.local> npm start
```

The first start prints a QR at `http://localhost:8788/qr` — scan it from WhatsApp →
Linked Devices. The session persists in `./creds`, so restarts stay paired. If
WhatsApp logs the device out, delete `creds/` and re-pair.

## Env

| Var | Meaning |
| --- | --- |
| `WHATSAPP_BRIDGE_SECRET` | shared secret — the only auth on both hops. Required. |
| `WHATSAPP_BRIDGE_PORT` | HTTP port. Default `8788`. |
| `APP_URL` | where the Next app lives. Default `http://localhost:3000`. |
| `WA_CREDS_DIR` | where the linked-device session persists. Default `./creds`. |

## In the app

Each inbound message becomes a `whatsapp` row in `surface_identities` / a session in
`surface_threads` — binding commands work the same as Slack: send `use example.com`
to the chat to follow that site's audits there. Approvals still happen where the
cards exist (Slack, Discord, web) — WhatsApp replies carry the proposal id instead.

Unofficial client — a normal WhatsApp account linked as a device, not the Cloud API.
Pace sends (the bridge does, ~1.2s apart) and don't blast strangers; that's what
gets numbers banned.
