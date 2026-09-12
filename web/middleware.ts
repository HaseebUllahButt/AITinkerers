import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

// Routes that require a session. The audit is deliberately NOT on this list: the
// whole point is that someone can paste a URL and get an answer without an account.
// Add prefixes here as gated surfaces appear.
const TOOL_PREFIXES: string[] = []

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
