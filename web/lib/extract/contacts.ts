import { normalizeWaNumber } from "@/lib/email/whatsappNote";

export interface FoundContact {
  type: "mailto" | "form" | "author_page" | "twitter" | "linkedin" | "mastodon" | "youtube" | "instagram" | "whatsapp";
  value: string;
  confidence: number;
}

const EMAIL_RE = /(?:mailto:|(?<=["'\s>]))([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/g;
const TWITTER_RE = /(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,50})(?:\/|"|'|\s|$)/g;
const LINKEDIN_RE = /linkedin\.com\/in\/([A-Za-z0-9\-_%]+)(?:\/|"|'|\s|$)/g;
const MASTODON_RE = /(@[A-Za-z0-9_]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g;
const YOUTUBE_RE = /youtube\.com\/(?:c\/|channel\/|@)([A-Za-z0-9_\-]+)(?:\/|"|'|\s|$)/g;
const INSTAGRAM_RE = /instagram\.com\/([A-Za-z0-9_.]+)(?:\/|"|'|\s|$)/g;
const CONTACT_FORM_RE = /href=["']([^"']*(?:contact|get-in-touch|reach-out|write-for-us)[^"']*)["']/gi;
// Click-to-chat links in all three spellings. The number token is captured raw and normalized
// before storing — hex letters belong in the class because the token may arrive percent-encoded
// ("phone=%2B92…"), and normalizeWaNumber is what decodes/strips safely.
const WHATSAPP_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=|whatsapp:\/\/send\?phone=)([+%\d][\da-fA-F\-().%\s]{5,24})/gi;

function validEmail(email: string): boolean {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email) &&
    !email.includes("example.com") &&
    !email.includes("youremail") &&
    !email.includes("email@");
}

export function extractContacts(html: string, text: string, baseUrl: string): FoundContact[] {
  const contacts: FoundContact[] = [];
  const seen = new Set<string>();

  function add(c: FoundContact) {
    const key = `${c.type}:${c.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      contacts.push(c);
    }
  }

  const combined = html + " " + text;

  // Emails
  for (const m of combined.matchAll(EMAIL_RE)) {
    const email = (m[1] ?? m[0]).toLowerCase();
    if (validEmail(email)) {
      add({ type: "mailto", value: `mailto:${email}`, confidence: 0.9, });
    }
  }

  // Twitter/X
  for (const m of combined.matchAll(TWITTER_RE)) {
    const handle = m[1].toLowerCase();
    if (handle.length > 1 && !["share", "intent", "home", "explore"].includes(handle)) {
      add({ type: "twitter", value: `https://x.com/${handle}`, confidence: 0.85 });
    }
  }

  // LinkedIn
  for (const m of combined.matchAll(LINKEDIN_RE)) {
    add({ type: "linkedin", value: `https://linkedin.com/in/${m[1]}`, confidence: 0.85 });
  }

  // Mastodon
  for (const m of combined.matchAll(MASTODON_RE)) {
    add({ type: "mastodon", value: m[1], confidence: 0.7 });
  }

  // YouTube
  for (const m of combined.matchAll(YOUTUBE_RE)) {
    add({ type: "youtube", value: `https://youtube.com/${m[1]}`, confidence: 0.8 });
  }

  // Instagram
  for (const m of combined.matchAll(INSTAGRAM_RE)) {
    const handle = m[1];
    if (!["p", "explore", "accounts", "reels"].includes(handle)) {
      add({ type: "instagram", value: `https://instagram.com/${handle}`, confidence: 0.75 });
    }
  }

  // WhatsApp click-to-chat — a direct human channel. Stored as the canonical wa.me URL so the
  // UI can both show it and derive the bare number from it.
  for (const m of combined.matchAll(WHATSAPP_RE)) {
    const digits = normalizeWaNumber(m[1]);
    if (digits) add({ type: "whatsapp", value: `https://wa.me/${digits}`, confidence: 0.85 });
  }

  // Contact forms
  for (const m of combined.matchAll(CONTACT_FORM_RE)) {
    try {
      const resolved = new URL(m[1], baseUrl).href;
      add({ type: "form", value: resolved, confidence: 0.6 });
    } catch {}
  }

  return contacts;
}
