import type React from "react"

// The operator surface is one page for now. The sidebar, top bar and page container that used to
// live here belonged to the ported tool and went with it; this stays deliberately bare so the
// audit is the whole screen until there is a second thing worth navigating between.
export default function ToolLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <div className="min-h-svh bg-background text-foreground">{children}</div>
}
