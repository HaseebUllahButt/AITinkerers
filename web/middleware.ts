import { NextResponse } from "next/server"

// There is no login page and no gated route: every surface is open. The file stays as the single
// obvious place to put a gate back, rather than being deleted and rediscovered later.
export function middleware() {
  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
}
