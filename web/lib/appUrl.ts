// Summit's own base URL, and the one rule that matters about it.
//
// ── Why this is not just `process.env.APP_URL` ──────────────────────────────────────────────────
//
// APP_URL has two jobs that look identical and are not. Internally it is where the app calls
// ITSELF — the media route, the blog-request worker — and `http://localhost:3000` is correct there
// in development. Externally it goes into a Slack message read by other people, and localhost is
// not merely useless there: it is a link that silently fails for everyone who clicks it, in a
// channel where six people were just tagged.
//
// Measured: a routing test posted "Open it: http://localhost:3000/drafts" to the whole team,
// because the local env sets APP_URL to localhost — which is the RIGHT value for the self-calls in
// the same file. One variable, two audiences, and only one of them can tolerate a loopback address.
//
// So outbound links go through publicUrl(), which returns null rather than a private address, and
// callers drop the line instead of printing something broken.
const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|.*\.local)$/i;

function normalise(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim().replace(/\/+$/, "");
  if (!v) return null;
  try {
    const u = new URL(v);
    if (!/^https?:$/.test(u.protocol)) return null;
    return PRIVATE_HOST.test(u.hostname) ? null : `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * The base URL for calls Summit makes to ITSELF.
 *
 * Loopback is fine and expected here, so this deliberately does not filter it. Keeping the two
 * functions separate is the point: a self-call that silently stopped working in development
 * because a URL was "sanitised" would be a far more confusing bug than a missing Slack link.
 */
export function internalUrl(): string {
  return (process.env.APP_URL || process.env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * The base URL safe to put in a message someone else will read, or null when there isn't one.
 *
 * Null is a real answer and callers must handle it — see linkOr(). Returning a best-guess
 * production URL instead would be worse: a hardcoded fallback is wrong the day the domain moves,
 * and it would hide the misconfiguration rather than surface it.
 */
export function publicUrl(): string | null {
  return normalise(process.env.APP_URL) ?? normalise(process.env.NEXTAUTH_URL);
}

/**
 * A link line for an outbound message, or null to omit it entirely.
 *
 * A notification with no link still names the draft and says where to look. A notification with a
 * dead link tells six people to click something that fails, which is strictly worse — and the
 * failure lands on them rather than on whoever set the variable.
 */
export function linkOr(path: string, label: string): string | null {
  const base = publicUrl();
  if (!base) {
    // Loud on the server, silent in the channel. Whoever is reading logs can fix it; the people in
    // Slack should not be shown Summit's configuration problems.
    console.warn(
      "[slack] APP_URL is unset or points at a private host, so the %s link was left out of an outbound message. " +
        "Set APP_URL to Summit's public URL.",
      label,
    );
    return null;
  }
  return `${label} ${base}${path.startsWith("/") ? path : `/${path}`}`;
}
