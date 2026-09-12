import type React from "react"

import { MobileNav, Sidebar } from "@/components/layout/Sidebar"

// The operator shell: sidebar flush to the left edge, content beside it. Each surface owns its own
// page — the audit is its own screen, not a panel on the dashboard — and the sidebar is the single
// place that knows what surfaces exist.
export default function ToolLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex h-svh overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
