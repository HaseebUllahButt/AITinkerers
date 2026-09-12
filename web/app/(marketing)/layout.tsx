import type React from "react"
import { SmoothScroll } from "@/components/smooth-scroll"

// The public landing page: full-bleed, no operator chrome, lenis smooth
// scrolling and the grain overlay the sections are composed against.
export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="overflow-x-hidden">
      <div className="noise-overlay" aria-hidden="true" />
      <SmoothScroll>{children}</SmoothScroll>
    </div>
  )
}
