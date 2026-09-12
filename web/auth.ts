import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

// ── Open sign-in ────────────────────────────────────────────────────────────────────────────────
//
// Google OAuth and the @imagine.art domain allowlist have been removed. There is one provider and
// it accepts ANY email with no password and no verification: type an address, get a session.
//
// Read that plainly before deploying this. Anyone who can reach the URL can sign in AS ANYONE,
// including as an address the admin gate in lib/auth/admin.ts trusts. This surface can open pull
// requests against a repo and write to a live site, so an open door here is not only a data-read
// risk. It is fine while the only reachable instance is on localhost; it is not fine on a public
// hostname.
//
// The login page has been removed, so there is no sign-in UI at all — a session is minted by
// whatever calls signIn, and every surface is reachable without one.
//
// To restore real auth: add back a provider (`Google({ clientId, clientSecret })`), a page to sign
// in on, a `pages.signIn` pointing at it, and the domain check in the signIn callback.
const isProd = process.env.NODE_ENV === "production";

// next-auth v5 refuses to start without a secret. With an open provider the secret is not what is
// keeping anyone out, so a missing one no longer blocks startup — but say so, once, in production.
const secret = process.env.AUTH_SECRET ?? "dev-only-insecure-secret-do-not-use-in-prod";
if (isProd && !process.env.AUTH_SECRET) {
  console.warn(
    "[auth] AUTH_SECRET is not set — falling back to a public, well-known value. " +
    "Session cookies can be forged by anyone who has read this source. Set AUTH_SECRET.",
  );
}
if (isProd) {
  console.warn(
    "[auth] Open sign-in is enabled: any email is accepted with no password. " +
    "Do not expose this deployment on a public hostname.",
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  secret,
  providers: [
    Credentials({
      id: "open",
      name: "Email",
      credentials: { email: { label: "Email", type: "email" } },
      async authorize(credentials) {
        const email = String(credentials?.email ?? "").trim() || "user@localhost";
        return { id: email.toLowerCase(), name: email.split("@")[0], email };
      },
    }),
  ],
  callbacks: {
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.sub;
      }
      return session;
    },
  },
});
