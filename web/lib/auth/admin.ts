// Admin allowlist. The app itself is gated to the northwind.example domain by sign-in; "admin" is a
// smaller set allowed to do powerful things like send AS another teammate. Configured via the
// ADMIN_EMAILS env (comma-separated); defaults to admin@northwind.example when unset.
export function getAdminEmails(): string[] {
  const raw = process.env.ADMIN_EMAILS?.trim() || "admin@northwind.example";
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function isAdminEmail(email?: string | null): boolean {
  if (!email) return false;
  return getAdminEmails().includes(email.toLowerCase());
}

/**
 * The superuser: may read OTHER people's Summer conversations.
 *
 * Deliberately NOT the admin list, and narrower than it. Admin already means "can do powerful
 * things", and there are two people on it — but reading a colleague's chat history is a different
 * kind of power from sending an email as them. Chats contain half-formed thinking, and the person
 * writing them has no idea anyone else can see them.
 *
 * So it is its own list, defaulting to exactly one person, and widening it takes a deliberate env
 * change rather than happening as a side effect of someone being made an admin.
 */
export function getSuperUserEmails(): string[] {
  const raw = process.env.SUPERUSER_EMAILS?.trim() || "owner@northwind.example";
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function isSuperUser(email?: string | null): boolean {
  if (!email) return false;
  return getSuperUserEmails().includes(email.toLowerCase());
}
