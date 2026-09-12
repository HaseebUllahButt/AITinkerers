import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// Every operator route lives under app/(tool). Route groups are erased from the
// URL, so the group name cannot be matched — the paths are listed instead, and
// this list is the one place that knows which surface is which.
const TOOL_PREFIXES = [
  "/dashboard", "/site-audit", "/geo", "/js-render-audit", "/render-lab",
  "/404s", "/research", "/handbook", "/workflows", "/indexing", "/link-audit",
  "/admin", "/settings", "/hermes", "/drafts", "/backlinks", "/blog",
  "/campaigns", "/emails", "/inbox", "/notifications", "/media", "/negotiation",
  "/payments", "/roi", "/sending", "/summer", "/whatsapp", "/email-finder",
]

const SESSION_COOKIES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
]

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl

  const isTool = TOOL_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  )
  if (!isTool) return NextResponse.next()

  // Presence of the cookie only — verifying the JWT needs the Node runtime and
  // every page below already calls auth() for the real check. This is about
  // sending a signed-out visitor somewhere useful, not about authorisation.
  const signedIn = SESSION_COOKIES.some((c) => req.cookies.has(c))
  if (signedIn) return NextResponse.next()

  const login = new URL("/login", req.url)
  login.searchParams.set("callbackUrl", pathname + search)
  return NextResponse.redirect(login)
}

export const config = {
  // Skip API routes, static assets and files with an extension.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
}
