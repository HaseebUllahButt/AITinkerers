"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { UserEmailConfigCard } from "@/components/settings/UserEmailConfig";
import { DailyDigestCard } from "@/components/settings/DailyDigestCard";
import { TavilyKeyManager } from "@/components/settings/TavilyKeyManager";
import { PageHeader } from "@/components/layout/PageHeader";

interface ConfigItem {
  key: string;
  label: string;
  description: string;
  required: boolean;
  set: boolean;
  category: string;
}

// We expose config status without leaking secrets — values are not shown
const CONFIG: ConfigItem[] = [
  { key: "NEXT_PUBLIC_SUPABASE_URL", label: "Supabase URL", description: "Your Supabase project URL", required: true, set: true, category: "Database" },
  { key: "NEXT_PUBLIC_SUPABASE_ANON_KEY", label: "Supabase Anon Key", description: "Public API key for client-side queries", required: true, set: true, category: "Database" },
  { key: "SUPABASE_SERVICE_ROLE_KEY", label: "Supabase Service Role Key", description: "Server-side admin key (bypasses RLS)", required: true, set: true, category: "Database" },
  { key: "AUTH_SECRET", label: "Auth Secret", description: "32+ char random string for session signing", required: true, set: true, category: "Auth" },
  { key: "GOOGLE_CLIENT_ID", label: "Google Client ID", description: "Google OAuth 2.0 client ID", required: true, set: true, category: "Auth" },
  { key: "GOOGLE_CLIENT_SECRET", label: "Google Client Secret", description: "Google OAuth 2.0 client secret", required: true, set: true, category: "Auth" },
  { key: "ALLOWED_DOMAINS", label: "Allowed Domains", description: "Comma-separated domains for login (e.g. imagine.art)", required: true, set: true, category: "Auth" },
  { key: "OPENROUTER_API_KEY", label: "OpenRouter API Key", description: "Used for AI-generated author descriptions (Claude Haiku)", required: false, set: true, category: "AI/LLM" },
  { key: "PLAYWRIGHT_ENABLED", label: "Playwright Enabled", description: "Set to 'true' to enable JS-rendered scraping locally", required: false, set: true, category: "Scraping" },
  { key: "BRAVE_SEARCH_API_KEY", label: "Brave Search API Key", description: "Free tier: 2000 queries/month. Enables Brave harvester.", required: false, set: false, category: "Scraping" },
  { key: "AHREFS_API_KEY", label: "Ahrefs API Key", description: "Domain authority signal — works unauthenticated until 2026-08-10, then needs a free key", required: false, set: false, category: "Scoring" },
  { key: "STRAPI_URL", label: "Strapi URL", description: "Base URL of the blog CMS (dev instance)", required: false, set: true, category: "CMS" },
  { key: "STRAPI_API_TOKEN", label: "Strapi API Token", description: "Read/write token — Strapi admin → Settings → API Tokens", required: false, set: true, category: "CMS" },
  { key: "STRAPI_BLOG_TYPE", label: "Strapi Blog Content Type", description: "Plural API ID of the blog collection (discovered via scripts/strapi_probe.mjs)", required: false, set: true, category: "CMS" },
];

const CATEGORIES = [...new Set(CONFIG.map((c) => c.category))];

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Settings" />

      {/* Per-user sending identity (each user sends from their own Gmail) */}
      <UserEmailConfigCard />

      <DailyDigestCard />

      {/* Rotating Tavily key pool — add many keys; auto-rolls over on quota */}
      <TavilyKeyManager />

      <p className="text-muted-foreground text-sm">
        API keys and configuration are managed via <code className="bg-muted px-1 rounded text-highlight-ink">.env.local</code>.
        Restart the server after any changes.
      </p>

      {/* Config status by category */}
      {CATEGORIES.map((cat) => {
        const items = CONFIG.filter((c) => c.category === cat);
        const allSet = items.filter((c) => c.required).every((c) => c.set);
        return (
          <Card key={cat}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{cat}</CardTitle>
                <Badge variant="outline" className={allSet ? "border-success/40 text-success" : "border-warning/50 text-warning"}>
                  {allSet ? "Ready" : "Action needed"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {items.map((item, i) => (
                <div key={item.key}>
                  <div className="flex items-start justify-between gap-3 py-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <code className="text-sm text-highlight-ink font-mono">{item.key}</code>
                        <Badge variant="outline" className="text-xs px-1 py-0">
                          {item.required ? "required" : "optional"}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                    </div>
                    <div className={`flex items-center gap-1.5 shrink-0 text-xs font-medium ${item.set ? "text-success" : "text-muted-foreground"}`}>
                      {item.set ? "set" : "not set"}
                    </div>
                  </div>
                  {i < items.length - 1 && <Separator />}
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}

      {/* Quick setup guide */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Setup</CardTitle>
          <CardDescription>Steps to get the app fully running</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {[
            { step: 1, label: "Run the SQL migration", desc: "Copy migrations/001_initial.sql into your Supabase SQL Editor and run it." },
            { step: 2, label: "Set .env.local", desc: "Copy .env.example → .env.local and fill in Supabase + Google OAuth credentials." },
            { step: 3, label: "Install Playwright browser", desc: "Run: npx playwright install chromium (skip for Vercel deployment)." },
            { step: 4, label: "Start the app", desc: "npm run dev — visit http://localhost:3000 and sign in with your @imagine.art account." },
            { step: 5, label: "Run first discovery", desc: "Click Run Discovery on the Prospects page. GDELT + HN + Reddit will populate your first prospects." },
          ].map(({ step, label, desc }) => (
            <div key={step} className="flex gap-3">
              <div className="w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">{step}</div>
              <div>
                <p className="font-medium text-sm">{label}</p>
                <p className="text-muted-foreground text-xs mt-0.5">{desc}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Vercel deployment note */}
      <Card className="border-warning/20 bg-warning/5">
        <CardContent className="pt-4">
          <p className="text-sm text-warning font-semibold mb-1">Vercel deployment note</p>
          <p className="text-xs text-muted-foreground">
            Playwright requires a headless Chromium browser which doesn't run in Vercel's serverless environment.
            Set <code className="bg-muted px-1 rounded">PLAYWRIGHT_ENABLED=false</code> on Vercel — the app will fall back to
            fast static fetching with Cheerio for all pages (covers ~85% of sites).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
