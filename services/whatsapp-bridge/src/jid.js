// WhatsApp JID helpers, adapted from Sangi (~/dev/me/hehe/Sangi/lib/jid.js). WhatsApp hands the
// same human to us as `92300...@s.whatsapp.net`, as `2061...@lid`, and with a `:3` device suffix;
// normalising in one place is what keeps identity comparisons honest.

const MIN_NUMBER_LENGTH = 6

export function digitsOf(value) {
  return String(value || '').replace(/[^0-9]/g, '')
}

export function normalize(jid) {
  return String(jid || '').toLowerCase().trim()
}

export function isGroup(jid) {
  return normalize(jid).endsWith('@g.us')
}

export function isPhoneJid(jid) {
  return normalize(jid).endsWith('@s.whatsapp.net')
}

export function isBroadcast(jid) {
  const value = normalize(jid)
  return value.endsWith('@broadcast') || value.endsWith('@newsletter') || value === 'status@broadcast'
}

// "923009876543:3@s.whatsapp.net" -> "923009876543"
export function userPart(jid) {
  return normalize(jid).split('@')[0].split(':')[0]
}

// Numbers arrive with and without country prefixes, so compare on suffix. The length floor
// matters: without it a 2-digit entry would match every number on WhatsApp.
export function sameNumber(a, b) {
  const left = digitsOf(a)
  const right = digitsOf(b)
  if (left.length < MIN_NUMBER_LENGTH || right.length < MIN_NUMBER_LENGTH) return false
  return left === right || left.endsWith(right) || right.endsWith(left)
}
