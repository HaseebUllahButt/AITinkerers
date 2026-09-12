import type React from "react"
import type { Metadata } from "next"
import { IBM_Plex_Sans, IBM_Plex_Mono, Bebas_Neue } from "next/font/google"
import { SessionProvider } from "next-auth/react"
import { Analytics } from "@vercel/analytics/next"
import { auth } from "@auth"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import "./globals.css"

const ibmPlexSans = IBM_Plex_Sans({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-sans",
})
const ibmPlexMono = IBM_Plex_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-geist-mono",
})
const bebasNeue = Bebas_Neue({ weight: "400", subsets: ["latin"], variable: "--font-bebas" })

export const metadata: Metadata = {
  title: {
    default: "SearchOps — An SEO, AEO & GEO Agent for Web Applications",
    template: "%s · SearchOps",
  },
  description:
    "A persistent search-growth operator. SearchOps understands your application, finds search opportunities, proposes and applies safe changes, verifies the live result, and keeps score.",
  icons: {
    icon: [
      { url: "/icon-light-32x32.png", media: "(prefers-color-scheme: light)" },
      { url: "/icon-dark-32x32.png", media: "(prefers-color-scheme: dark)" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-icon.png",
  },
}

// The root layout carries only <html>/<body>, the type stack and the session.
// Chrome lives in the route groups: (marketing) keeps the landing page's
// bespoke treatment, (tool) mounts the operator shell.
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await auth()

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${ibmPlexSans.variable} ${bebasNeue.variable} ${ibmPlexMono.variable} font-sans antialiased`}
      >
        {/* defaultTheme dark keeps the look the product shipped with; enableSystem means a
            visitor who has asked their OS for light gets it without hunting for a toggle. */}
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <SessionProvider session={session}>
            {children}
            <Toaster position="bottom-right" />
          </SessionProvider>
        </ThemeProvider>
        <Analytics />
      </body>
    </html>
  )
}
