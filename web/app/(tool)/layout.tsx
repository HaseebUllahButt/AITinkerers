import type React from "react"
import { auth } from "@auth"
import { Sidebar } from "@/components/layout/Sidebar"
import { PageContainer } from "@/components/layout/PageContainer"
import { TopNav } from "@/components/layout/TopNav"
import { RouteProgress } from "@/components/layout/RouteProgress"
import { UsageTracker } from "@/components/layout/UsageTracker"

// The operator surface, ported from SearchOps: sidebar flush to the left edge,
// flat top bar, content straight below. Chrome only renders for a signed-in
// session so /login stays bare.
export default async function ToolLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth()

  return (
    <>
      {session?.user && <RouteProgress />}
      {session?.user && <UsageTracker />}
      <div className="flex h-svh overflow-hidden bg-background text-foreground">
        {session?.user && <Sidebar />}
        <div className="flex min-h-0 flex-1 flex-col min-w-0">
          {session?.user && <TopNav />}
          <main className="min-h-0 flex-1 overflow-y-auto">
            <PageContainer>{children}</PageContainer>
          </main>
        </div>
      </div>
    </>
  )
}
