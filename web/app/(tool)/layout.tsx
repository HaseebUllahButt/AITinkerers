import type React from "react"

import { PageContainer } from "@/components/layout/PageContainer"
import { RouteProgress } from "@/components/layout/RouteProgress"
import { Sidebar } from "@/components/layout/Sidebar"
import { TopNav } from "@/components/layout/TopNav"
import { UsageTracker } from "@/components/layout/UsageTracker"

// The operator shell: sidebar flush to the left edge, flat top bar, content straight below.
//
// The chrome used to render only for a signed-in session, so that /login could sit bare inside the
// same layout. There is no login page any more — every surface here is open — so the session check
// went with it and the shell is unconditional.
export default function ToolLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <RouteProgress />
      <UsageTracker />
      <div className="flex h-svh overflow-hidden bg-background text-foreground">
        <Sidebar />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TopNav />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <PageContainer>{children}</PageContainer>
          </main>
        </div>
      </div>
    </>
  )
}
