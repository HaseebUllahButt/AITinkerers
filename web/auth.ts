import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";

const ALLOWED_DOMAIN = process.env.ALLOWED_DOMAINS ?? "imagine.art";

const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// ── Running without Google OAuth ────────────────────────────────────────────────────────────────
//
// Google is the only real provider. Without a client id and secret there is no way in at all, which
// makes the whole operator surface unreachable on a fresh checkout. So outside production, and only
// when Google is genuinely unconfigured, a local provider stands in: type any email, get a session.
//
// Both conditions are required. In production a missing client id is a misconfiguration to shout
// about, not a reason to hand out sessions — `isProd` alone gates this, so no environment variable
// can switch it on in a deployed build.
const isProd = process.env.NODE_ENV === "production";
const googleConfigured = Boolean(GOOGLE_ID && GOOGLE_SECRET);
export const devSignInEnabled = !isProd && !googleConfigured;

// next-auth v5 refuses to start without a secret. Generating one per process would invalidate every
// session on restart, so dev gets a fixed, obviously-fake value. Production still requires the real
// variable and fails loudly without it.
const secret =
  process.env.AUTH_SECRET ?? (isProd ? undefined : "dev-only-insecure-secret-do-not-use-in-prod");

const providers = [];
if (googleConfigured) {
  providers.push(Google({ clientId: GOOGLE_ID!, clientSecret: GOOGLE_SECRET! }));
}
if (devSignInEnabled) {
  providers.push(
    Credentials({
      id: "dev",
      name: "Local development",
      credentials: { email: { label: "Email", type: "email" } },
      async authorize(credentials) {
        const email = String(credentials?.email ?? "").trim() || "dev@localhost";
        return { id: "dev-user", name: email.split("@")[0], email };
      },
    }),
  );
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  secret,
  providers,
  callbacks: {
    async signIn({ user, account }) {
      // The dev provider is already gated on !isProd above; domain rules are about who in the real
      // organisation may sign in, and do not apply to a local stand-in.
      if (account?.provider === "dev") return true;

      const email = user.email ?? "";
      const allowed = ALLOWED_DOMAIN.split(",").map((d) => d.trim());
      const domain = email.split("@")[1];
      if (!allowed.includes(domain)) {
        return `/login?error=domain&email=${encodeURIComponent(email)}`;
      }
      return true;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.sub;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
});
