"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type Status = { running: boolean; progress?: string | null };

async function getStatus(): Promise<Status> {
  const res = await fetch("/api/js-render-audit/status", { cache: "no-store" });
  return res.json();
}

export function RunAuditControls() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ running: false });
  const [error, setError] = useState<string | null>(null);
  const [localOnly, setLocalOnly] = useState(false);
  const wasRunning = useRef(false);

  // Poll while a run is active — including one already in progress from before this page loaded,
  // so reloading mid-run shows "running" instead of letting someone start a second one on top of it.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const s = await getStatus().catch(() => ({ running: false }) as Status);
      if (cancelled) return;
      setStatus(s);
      if (wasRunning.current && !s.running) router.refresh(); // just finished — pull the new report
      wasRunning.current = s.running;
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [router]);

  async function start(limit?: number) {
    setError(null);
    let res: Response;
    let body: { ok?: boolean; error?: string; localOnly?: boolean } = {};
    try {
      res = await fetch("/api/js-render-audit/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(limit ? { limit } : {}),
      });
      body = await res.json().catch(() => ({}));
    } catch {
      setError("Could not reach the server to start the run.");
      return;
    }
    if (res.status === 409) {
      setStatus({ running: true });
      return;
    }
    // A 200 with ok:false is the deployed-site case: the request reached the server fine, but
    // there's no Chromium to run the audit with. Distinct from a real failure, so it gets its own
    // (non-red) message instead of "check the terminal running `next dev`" on a site with no
    // terminal, and the buttons retire instead of inviting another click that will do the same thing.
    if (body.localOnly) {
      setLocalOnly(true);
      setError(body.error ?? null);
      return;
    }
    if (!res.ok || body.ok === false) {
      setError(body.error ?? "Could not start the run — check the terminal running `next dev`.");
      return;
    }
    setStatus({ running: true, progress: null });
    wasRunning.current = true;
  }

  if (localOnly) {
    return <p className="text-sm text-muted-foreground">{error}</p>;
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" disabled={status.running} onClick={() => start()}>
        {status.running ? "Running…" : "Run full audit"}
      </Button>
      <Button size="sm" variant="outline" disabled={status.running} onClick={() => start(15)}>
        Quick test (15 pages)
      </Button>
      {status.running && (
        <span className="text-sm text-muted-foreground">
          {status.progress ?? "starting — launching Chrome…"}
        </span>
      )}
      {error && <span className="text-sm text-destructive">{error}</span>}
    </div>
  );
}
