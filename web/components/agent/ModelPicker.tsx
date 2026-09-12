"use client";

// Which Claude model this conversation runs on.
//
// Lives in the composer toolbar rather than in a settings page because the choice is per-
// conversation and the decision is made at the moment you type: "what needs my attention" does not
// need Opus, and you only know that as you ask it.
//
// ── The cache is why this is per-session and not per-turn ───────────────────────────────────────
//
// Prompt caching is keyed on the model. Every turn of one conversation should hit the same cache;
// a switch throws that away and the next turn pays a full cache write on the whole history. That is
// a real cost, it is invisible, and it is why the menu says so rather than flipping silently.

import { useCallback, useState } from "react";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
  DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface ModelOption {
  id: string;
  label: string;
  note: string;
}

export interface ModelPickerProps {
  /** The models the server will accept. Passed in rather than imported so this component never
   *  drifts from the allowlist the API actually enforces. */
  options: readonly ModelOption[];
  /** The session's stored model. Null means the default — the first option. */
  value: string | null;
  /** Null when no conversation exists yet: the picker still shows and still records a choice, which
   *  is then used to OPEN the session, so the first turn already runs on the chosen model. */
  sessionId: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
}

export function ModelPicker({ options, value, sessionId, onChange, disabled }: ModelPickerProps) {
  const [saving, setSaving] = useState(false);
  const current = options.find((o) => o.id === value) ?? options[0];
  const isDefault = !value || value === options[0]?.id;

  const pick = useCallback(async (id: string) => {
    if (id === (value ?? options[0]?.id)) return;
    // The default is stored as null, not as its id — see createHermesSession. A session pinned to
    // "claude-sonnet-5" would keep that id after the default moved on, which is the opposite of what
    // choosing "Default" means.
    const next = id === options[0]?.id ? null : id;

    // No session yet: hold the choice locally and let the page use it when it opens one. Minting a
    // session just to record a preference would litter the rail with empty conversations.
    if (!sessionId) { onChange(next); return; }

    setSaving(true);
    // Optimistic: the menu should close on the model you picked, not blink back and forward.
    onChange(next);
    try {
      const res = await fetch(`/api/hermes/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: next ?? "" }),
      });
      const r = await res.json().catch(() => null);
      if (!r?.ok) {
        // Roll back to what the server still believes, so the label never claims a model the next
        // turn will not actually use.
        onChange(value);
        toast.error(r?.error ?? "Couldn't switch model.");
      }
    } catch {
      onChange(value);
      toast.error("Couldn't switch model — network error.");
    } finally {
      setSaving(false);
    }
  }, [onChange, options, sessionId, value]);

  return (
    <DropdownMenu>
      {/* The trigger IS the button — this repo's DropdownMenuTrigger renders a native <button> and
          has no `asChild`, so wrapping one inside it nests a button in a button. */}
      <DropdownMenuTrigger
        disabled={disabled || saving}
        title="Which Claude model answers in this conversation"
        className={cn(
          "inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs transition-colors",
          "text-muted-foreground hover:bg-accent hover:text-foreground",
          "disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        <Sparkles className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-[7.5rem] truncate">{current?.label ?? "Model"}</span>
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-72">
        {options.map((o, i) => {
          const selected = i === 0 ? isDefault : o.id === value;
          return (
            <DropdownMenuItem
              key={o.id}
              // onClick, NOT onSelect. This is Base UI's Menu.Item, whose props extend the DOM's,
              // so `onSelect` typechecks — it resolves to the native text-selection handler — and
              // then never fires. It looked correct, compiled clean, and did nothing; every other
              // menu in this repo uses onClick.
              onClick={() => { void pick(o.id); }}
              className="flex items-start gap-2 py-2"
            >
              <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} />
              <span className="min-w-0">
                <span className="block text-xs font-medium">{o.label}</span>
                <span className="block text-xs text-muted-foreground">{o.note}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
        {/* Stated, not hidden: switching mid-conversation is not free, and the cost is invisible
            everywhere else. Only shown once a conversation exists — there is no cache to lose on a
            chat that has not started.
            Label + Separator rather than a bare <p>: Label renders a plain div the menu primitive
            already expects, whereas arbitrary markup inside the popup is not something the
            primitive promises to leave out of its keyboard navigation. */}
        {sessionId && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal leading-snug text-muted-foreground">
              Switching mid-chat re-sends the history to the new model once, so the next turn costs
              more than usual.
            </DropdownMenuLabel>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
