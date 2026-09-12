"use client";

import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SummitMark } from "@/components/brand/SummitMark";

function LoginContent() {
  const params = useSearchParams();
  const error = params.get("error");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    // `h-full`, not `min-h-screen`: the root layout already sizes `main` to `h-svh` and this page
    // sits inside it. `min-h-screen` on top of that fixed-height ancestor is exactly the phantom-scroll
    // bug that was fixed everywhere else in the app — a few extra pixels of intrinsic height would make
    // an unauthenticated visitor's very first screen scroll for no reason.
    <div className="flex h-full items-center justify-center">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center text-center gap-2">
          <SummitMark className="h-10 w-10 mb-1" />
          <h1 className="text-2xl font-light tracking-tight">SearchOps</h1>
          <p className="text-sm text-muted-foreground">SEO, AEO and GEO agent</p>
        </div>

        <Card className="glass-panel">
          <CardHeader className="text-center pb-4">
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Enter any email to continue</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                Sign-in failed. Please try again.
              </div>
            )}

            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setBusy(true);
                signIn("open", { email: email.trim() || "user@localhost", callbackUrl: "/" });
              }}
            >
              <Input
                id="login-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                aria-label="Email"
              />
              <Button type="submit" className="w-full" size="lg" disabled={busy}>
                {busy ? "Signing in…" : "Continue"}
              </Button>
            </form>

            <p className="text-xs text-center text-muted-foreground">
              No password required while the tool is in development.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default function LoginForm() {
  return (
    <Suspense fallback={<div className="h-full" />}>
      <LoginContent />
    </Suspense>
  );
}
