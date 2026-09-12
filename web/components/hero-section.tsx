"use client"

import { useEffect, useRef, useState } from "react"
import { ScrambleTextOnHover } from "@/components/scramble-text"
import { SplitFlapText, SplitFlapMuteToggle, SplitFlapAudioProvider } from "@/components/split-flap-text"
import { AnimatedNoise } from "@/components/animated-noise"
import { BitmapChevron } from "@/components/bitmap-chevron"
import { recordAudit, saveLastResult } from "@/lib/audit/history"
import { useRouter } from "next/navigation"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"

gsap.registerPlugin(ScrollTrigger)

// The audit makes real crawls and a few dozen model calls, so it runs for a minute or more. A bare
// spinner for that long reads as a hang; naming the stage it is on is the difference between
// "working" and "broken".
const STAGES = [
  { label: "Fetching the page", detail: "and reading its HTML" },
  { label: "Reading robots.txt, llms.txt and the sitemap", detail: "what the site publishes about itself" },
  { label: "Finding competitors", detail: "searching alternatives, then verifying each one resolves" },
  { label: "Asking the assistants", detail: "buyer questions that name no brand" },
  { label: "Profiling competitors", detail: "the identical pass, so the comparison is fair" },
  { label: "Writing the findings", detail: "evidence first, then the fix" },
]

export function HeroSection() {
  const sectionRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const [url, setUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // Advances on a timer rather than from real progress: the API returns one response at the end,
  // so this is an honest estimate of the sequence, not a fake percentage.
  useEffect(() => {
    if (!busy) return
    setStage(0)
    setElapsed(0)
    const tick = setInterval(() => setElapsed((e) => e + 1), 1000)
    const step = setInterval(() => setStage((s) => Math.min(s + 1, STAGES.length - 1)), 18_000)
    return () => {
      clearInterval(tick)
      clearInterval(step)
    }
  }, [busy])

  async function runAudit(e: React.FormEvent) {
    e.preventDefault()
    const target = url.trim()
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "The audit failed.")
        setBusy(false)
        return
      }
      saveLastResult(data)
      recordAudit({
        url: data.url,
        domain: data.domain,
        brand: data.brand,
        score: data.score,
        criticals: (data.findings ?? []).filter((f: { severity: string }) => f.severity === "critical").length,
        at: data.fetchedAt,
      })
      router.push("/dashboard")
    } catch {
      setError("Could not reach the audit service.")
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!sectionRef.current || !contentRef.current) return

    const ctx = gsap.context(() => {
      gsap.to(contentRef.current, {
        y: -100,
        opacity: 0,
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top top",
          end: "bottom top",
          scrub: 1,
        },
      })
    }, sectionRef)

    return () => ctx.revert()
  }, [])

  return (
    <section ref={sectionRef} id="hero" className="relative min-h-screen flex items-center px-6 md:px-28">
      <AnimatedNoise opacity={0.03} />

      {/* Left vertical labels */}
      <div className="absolute left-4 md:left-6 top-1/2 hidden -translate-y-1/2 md:block">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-muted-foreground -rotate-90 origin-left block whitespace-nowrap">
          SEARCHOPS
        </span>
      </div>

      {/* Main content */}
      <div ref={contentRef} className="mx-auto flex w-full max-w-4xl flex-col items-center text-center">
        <SplitFlapAudioProvider>
          <div className="relative">
            <SplitFlapText text="SEARCHOPS" speed={80} />
            <div className="mt-4 flex justify-center">
              <SplitFlapMuteToggle />
            </div>
          </div>
        </SplitFlapAudioProvider>

        <h2 className="font-[var(--font-bebas)] text-muted-foreground/60 text-[clamp(1rem,3vw,2rem)] mt-4 tracking-wide">
          An SEO, AEO and GEO Agent
        </h2>

        <p className="mt-12 mx-auto max-w-xl font-mono text-sm text-muted-foreground leading-relaxed">
          Not another audit tool or content generator. A persistent search-growth operator that understands the
          application, takes a safe action, verifies what happened, and keeps score.
        </p>

        {/* The point of the page: put a URL in and get an audit. */}
        <form onSubmit={runAudit} className="mt-12 w-full max-w-xl">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="hero-url"
              type="text"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
              placeholder="yourdomain.com"
              aria-label="URL to audit"
              className="h-12 flex-1 border border-foreground/20 bg-transparent px-4 font-mono text-sm text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={busy || !url.trim()}
              className="h-12 bg-accent px-6 font-mono text-xs uppercase tracking-widest text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Auditing…" : "Audit my site"}
            </button>
          </div>

          {busy && (
            <div className="mt-6 border border-foreground/15 bg-foreground/[0.03] p-5 text-left" role="status" aria-live="polite">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-mono text-[10px] uppercase tracking-widest text-accent">
                  Auditing {url.trim()}
                </span>
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")}
                </span>
              </div>

              {/* A checklist rather than a bar: each line is a thing that actually happens, so the
                  wait reads as work being done instead of time passing. */}
              <ul className="mt-4 space-y-2.5">
                {STAGES.map((s, i) => {
                  const done = i < stage
                  const current = i === stage
                  return (
                    <li key={s.label} className="flex items-start gap-3">
                      <span className="mt-[3px] flex h-3 w-3 shrink-0 items-center justify-center">
                        {done ? (
                          <svg viewBox="0 0 12 12" className="h-3 w-3 text-accent" aria-hidden>
                            <path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="2" />
                          </svg>
                        ) : current ? (
                          <span className="h-2 w-2 animate-ping rounded-full bg-accent" />
                        ) : (
                          <span className="h-1 w-1 rounded-full bg-muted-foreground/40" />
                        )}
                      </span>
                      <span className="min-w-0">
                        <span
                          className={`block font-mono text-xs ${
                            done ? "text-muted-foreground line-through decoration-muted-foreground/40" : current ? "text-foreground" : "text-muted-foreground/60"
                          }`}
                        >
                          {s.label}
                        </span>
                        {current && (
                          <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">{s.detail}</span>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>

              <div className="mt-4 h-px w-full bg-foreground/10">
                <div
                  className="h-px bg-accent transition-all duration-700 ease-out"
                  style={{ width: `${((stage + 1) / STAGES.length) * 100}%` }}
                />
              </div>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
                Real crawls and real model calls — a minute or two
              </p>
            </div>
          )}

          {error && <p className="mt-3 text-center font-mono text-xs text-destructive">{error}</p>}
        </form>

        <div className="mt-12 flex flex-wrap items-center justify-center gap-x-8 gap-y-4">
          {/* The primary action is now getting into the tool, not reading further down the page. */}
          <a
            href="/dashboard"
            className="group inline-flex items-center gap-3 bg-accent px-6 py-3 font-mono text-xs uppercase tracking-widest text-accent-foreground hover:bg-accent/90 transition-all duration-200"
          >
            <ScrambleTextOnHover text="Open Dashboard" as="span" duration={0.6} />
            <BitmapChevron className="transition-transform duration-[400ms] ease-in-out group-hover:rotate-45" />
          </a>
          <a
            href="#capabilities"
            className="group inline-flex items-center gap-3 border border-foreground/20 px-6 py-3 font-mono text-xs uppercase tracking-widest text-foreground hover:border-accent hover:text-accent transition-all duration-200"
          >
            <ScrambleTextOnHover text="View Capabilities" as="span" duration={0.6} />
          </a>
          <a
            href="#loop"
            className="font-mono text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors duration-200"
          >
            The Operating Loop
          </a>
        </div>
      </div>

      {/* Floating info tag */}
      <div className="absolute bottom-8 right-8 md:bottom-12 md:right-12">
        <div className="border border-border px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          v.01 / Working Draft
        </div>
      </div>
    </section>
  )
}
