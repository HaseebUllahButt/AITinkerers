"use client"

import { useState, useRef, useEffect } from "react"
import { cn } from "@/lib/utils"
import gsap from "gsap"
import { ScrollTrigger } from "gsap/ScrollTrigger"

gsap.registerPlugin(ScrollTrigger)

const capabilities = [
  {
    title: "Site Understanding",
    medium: "Context",
    description:
      "Routes, page types, rendering model, templates, entities, and internal-link relationships, including how one shared template changes many pages at once.",
    span: "col-span-2 row-span-2",
  },
  {
    title: "Technical Diagnosis",
    medium: "Crawl",
    description:
      "Indexability, robots and sitemaps, status codes, canonical conflicts, thin and orphan pages, and drift between intended and live behavior.",
    span: "col-span-1 row-span-1",
  },
  {
    title: "Opportunity Finder",
    medium: "Discovery",
    description:
      "Search and analytics data turned into ranked opportunities, each with evidence, expected impact, and confidence.",
    span: "col-span-1 row-span-1",
  },
  {
    title: "Answer Optimization",
    medium: "Content",
    description:
      "Direct answers, definitions, FAQs, comparisons, and how-to content grounded in verified site facts. No keyword stuffing, no doorway pages.",
    span: "col-span-2 row-span-1",
  },
  {
    title: "AEO & GEO Readiness",
    medium: "Visibility",
    description:
      "Self-contained passages, question-shaped headings, consistent entities, attribution, and freshness signals that answer engines can actually cite.",
    span: "col-span-1 row-span-2",
  },
  {
    title: "Structured Data",
    medium: "Schema",
    description:
      "Detect existing JSON-LD, compare markup against visible content, catch stale dates and statuses, and track schema across deployments.",
    span: "col-span-1 row-span-1",
  },
  {
    title: "Change Planning",
    medium: "Execution",
    description:
      "Exact files and fields, before-and-after diffs, source facts, required validation, risk level, rollback plan, and the expected measurement window.",
    span: "col-span-2 row-span-1",
  },
  {
    title: "Live Verification",
    medium: "Proof",
    description:
      "Re-fetch and render the deployed page. Local validation, deployment proof, search processing, and measured performance stay separate.",
    span: "col-span-1 row-span-1",
  },
  {
    title: "Search & AI Measurement",
    medium: "Outcome",
    description:
      "Baselines and outcome history: impressions, clicks, CTR, position, index coverage, conversions, citations, and competitor mentions.",
    span: "col-span-2 row-span-1",
  },
  {
    title: "Persistent Memory",
    medium: "Recall",
    description:
      "Site facts, approved terminology, prior fixes and their outcomes, rejected recommendations, and provider constraints. Structured and auditable.",
    span: "col-span-2 md:col-span-4 row-span-1",
  },
]

export function WorkSection() {
  const sectionRef = useRef<HTMLElement>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!sectionRef.current || !headerRef.current || !gridRef.current) return

    const ctx = gsap.context(() => {
      // Header slide in from left
      gsap.fromTo(
        headerRef.current,
        { x: -60, opacity: 0 },
        {
          x: 0,
          opacity: 1,
          duration: 1,
          ease: "power3.out",
          scrollTrigger: {
            trigger: headerRef.current,
            start: "top 90%",
            toggleActions: "play none none reverse",
          },
        },
      )

      const cards = gridRef.current?.querySelectorAll("article")
      if (cards && cards.length > 0) {
        gsap.set(cards, { y: 60, opacity: 0 })
        gsap.to(cards, {
          y: 0,
          opacity: 1,
          duration: 0.8,
          stagger: 0.1,
          ease: "power3.out",
          scrollTrigger: {
            trigger: gridRef.current,
            start: "top 90%",
            toggleActions: "play none none reverse",
          },
        })
      }
    }, sectionRef)

    return () => ctx.revert()
  }, [])

  return (
    <section ref={sectionRef} id="capabilities" className="relative py-32 pl-6 md:pl-28 pr-6 md:pr-12">
      {/* Section header */}
      <div ref={headerRef} className="mb-16 flex items-end justify-between">
        <div>
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-accent">02 / Capabilities</span>
          <h2 className="mt-4 font-[var(--font-bebas)] text-5xl md:text-7xl tracking-tight">CORE CAPABILITIES</h2>
        </div>
        <p className="hidden md:block max-w-xs font-mono text-xs text-muted-foreground text-right leading-relaxed">
          Ten capabilities spanning site understanding, technical diagnosis, content and answer optimization, safe
          execution, verification, and measurement.
        </p>
      </div>

      {/* Asymmetric grid */}
      <div
        ref={gridRef}
        className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6 auto-rows-[180px] md:auto-rows-[200px]"
      >
        {capabilities.map((capability, index) => (
          <CapabilityCard key={index} capability={capability} index={index} persistHover={index === 0} />
        ))}
      </div>
    </section>
  )
}

function CapabilityCard({
  capability,
  index,
  persistHover = false,
}: {
  capability: {
    title: string
    medium: string
    description: string
    span: string
  }
  index: number
  persistHover?: boolean
}) {
  const [isHovered, setIsHovered] = useState(false)
  const cardRef = useRef<HTMLElement>(null)
  const [isScrollActive, setIsScrollActive] = useState(false)

  useEffect(() => {
    if (!persistHover || !cardRef.current) return

    const ctx = gsap.context(() => {
      ScrollTrigger.create({
        trigger: cardRef.current,
        start: "top 80%",
        onEnter: () => setIsScrollActive(true),
      })
    }, cardRef)

    return () => ctx.revert()
  }, [persistHover])

  const isActive = isHovered || isScrollActive

  return (
    <article
      ref={cardRef}
      className={cn(
        "group relative border border-border/40 p-5 flex flex-col justify-between transition-all duration-500 cursor-pointer overflow-hidden",
        capability.span,
        isActive && "border-accent/60",
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Background layer */}
      <div
        className={cn(
          "absolute inset-0 bg-accent/5 transition-opacity duration-500",
          isActive ? "opacity-100" : "opacity-0",
        )}
      />

      {/* Content */}
      <div className="relative z-10">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {capability.medium}
        </span>
        <h3
          className={cn(
            "mt-3 font-[var(--font-bebas)] text-2xl md:text-4xl tracking-tight transition-colors duration-300",
            isActive ? "text-accent" : "text-foreground",
          )}
        >
          {capability.title}
        </h3>
      </div>

      {/* Description - reveals on hover */}
      <div className="relative z-10">
        <p
          className={cn(
            "font-mono text-xs text-muted-foreground leading-relaxed transition-all duration-500 max-w-[280px]",
            isActive ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2",
          )}
        >
          {capability.description}
        </p>
      </div>

      {/* Index marker */}
      <span
        className={cn(
          "absolute bottom-4 right-4 font-mono text-[10px] transition-colors duration-300",
          isActive ? "text-accent" : "text-muted-foreground/70",
        )}
      >
        {String(index + 1).padStart(2, "0")}
      </span>

      {/* Corner line */}
      <div
        className={cn(
          "absolute top-0 right-0 w-12 h-12 transition-all duration-500",
          isActive ? "opacity-100" : "opacity-0",
        )}
      >
        <div className="absolute top-0 right-0 w-full h-[1px] bg-accent" />
        <div className="absolute top-0 right-0 w-[1px] h-full bg-accent" />
      </div>
    </article>
  )
}
