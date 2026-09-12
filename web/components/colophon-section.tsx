"use client"

import { useRef, useEffect } from "react"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"

gsap.registerPlugin(ScrollTrigger)

export function ColophonSection() {
  const sectionRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sectionRef.current) return

    const ctx = gsap.context(() => {
      // Header slide in
      if (headerRef.current) {
        gsap.from(headerRef.current, {
          x: -60,
          opacity: 0,
          duration: 1,
          ease: "power3.out",
          scrollTrigger: {
            trigger: headerRef.current,
            start: "top 85%",
            toggleActions: "play none none reverse",
          },
        })
      }

      // Grid columns fade up with stagger
      if (gridRef.current) {
        const columns = gridRef.current.querySelectorAll(":scope > div")
        gsap.from(columns, {
          y: 40,
          opacity: 0,
          duration: 0.8,
          stagger: 0.1,
          ease: "power3.out",
          scrollTrigger: {
            trigger: gridRef.current,
            start: "top 85%",
            toggleActions: "play none none reverse",
          },
        })
      }

      // Footer fade in
      if (footerRef.current) {
        gsap.from(footerRef.current, {
          y: 20,
          opacity: 0,
          duration: 0.8,
          ease: "power3.out",
          scrollTrigger: {
            trigger: footerRef.current,
            start: "top 95%",
            toggleActions: "play none none reverse",
          },
        })
      }
    }, sectionRef)

    return () => ctx.revert()
  }, [])

  return (
    <section
      ref={sectionRef}
      id="colophon"
      className="relative py-32 pl-6 md:pl-28 pr-6 md:pr-12 border-t border-border/30"
    >
      {/* Section header */}
      <div ref={headerRef} className="mb-16">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent">04 / Colophon</span>
        <h2 className="mt-4 font-[var(--font-bebas)] text-5xl md:text-7xl tracking-tight">DETAILS</h2>
      </div>

      {/* Multi-column layout */}
      <div ref={gridRef} className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-8 md:gap-12">
        {/* First version scope */}
        <div className="col-span-1">
          <h4 className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground mb-4">First Version</h4>
          <ul className="space-y-2">
            <li className="font-mono text-xs text-foreground/80">Site &amp; Repo Context</li>
            <li className="font-mono text-xs text-foreground/80">Search Console</li>
            <li className="font-mono text-xs text-foreground/80">PR &amp; CMS Drafts</li>
            <li className="font-mono text-xs text-foreground/80">Live Verification</li>
          </ul>
        </div>

        {/* Delivery surfaces */}
        <div className="col-span-1">
          <h4 className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground mb-4">Surfaces</h4>
          <ul className="space-y-2">
            <li className="font-mono text-xs text-foreground/80">Slack / Teams</li>
            <li className="font-mono text-xs text-foreground/80">Repositories</li>
            <li className="font-mono text-xs text-foreground/80">CMS</li>
            <li className="font-mono text-xs text-foreground/80">Scheduled Jobs</li>
          </ul>
        </div>

        {/* What gets measured */}
        <div className="col-span-1">
          <h4 className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground mb-4">Measured</h4>
          <ul className="space-y-2">
            <li className="font-mono text-xs text-foreground/80">Impressions &amp; CTR</li>
            <li className="font-mono text-xs text-foreground/80">Index Coverage</li>
            <li className="font-mono text-xs text-foreground/80">AI Citations</li>
            <li className="font-mono text-xs text-foreground/80">Rollback Rate</li>
          </ul>
        </div>

        {/* Guardrails */}
        <div className="col-span-1">
          <h4 className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground mb-4">Guardrails</h4>
          <ul className="space-y-2">
            <li className="font-mono text-xs text-foreground/80">Least Privilege</li>
            <li className="font-mono text-xs text-foreground/80">Human Approval</li>
            <li className="font-mono text-xs text-foreground/80">Audit Log</li>
            <li className="font-mono text-xs text-foreground/80">Rollback</li>
          </ul>
        </div>

        {/* Source */}
        <div className="col-span-1">
          <h4 className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground mb-4">Source</h4>
          <ul className="space-y-2">
            <li>
              <a
                href="https://github.com/HaseebUllahButt/AITinkerers"
                className="font-mono text-xs text-foreground/80 hover:text-accent transition-colors duration-200"
              >
                Repository
              </a>
            </li>
            <li>
              <a
                href="https://github.com/HaseebUllahButt/AITinkerers/blob/main/seo-aeo-geo-agent.md"
                className="font-mono text-xs text-foreground/80 hover:text-accent transition-colors duration-200"
              >
                Spec
              </a>
            </li>
          </ul>
        </div>

        {/* Status */}
        <div className="col-span-1">
          <h4 className="font-mono text-[9px] uppercase tracking-[0.3em] text-muted-foreground mb-4">Status</h4>
          <ul className="space-y-2">
            <li className="font-mono text-xs text-foreground/80">Working Draft</li>
            <li className="font-mono text-xs text-foreground/80">2026</li>
            <li className="font-mono text-xs text-foreground/80">Ongoing</li>
          </ul>
        </div>
      </div>

      {/* Bottom copyright */}
      <div
        ref={footerRef}
        className="mt-24 pt-8 border-t border-border/20 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
      >
        <p className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">
          © 2026 SearchOps. Working draft.
        </p>
        <p className="font-mono text-[10px] text-muted-foreground">
          Do not build an agent that merely talks about SEO.
        </p>
      </div>
    </section>
  )
}
