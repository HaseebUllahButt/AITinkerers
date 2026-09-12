"use client";

// SearchOps Agent — a declarative form as a blocking ask.
//
// Spec: SUMMIT-AGENT-UI-SPEC.md §9.6.
//
// The agent ships a `FormSpec` (§4.2) and this renders it with SearchOps's own field primitives. Two
// behaviours are mandatory and are the reason this is a component and not a `prompt()`:
//
//  1. `allValid` over the REQUIRED fields drives `disabled` on Submit. An agent blocked on a form
//     must never receive a half-filled object — it cannot tell "the user left it blank" from "the
//     field does not exist" and will happily act on the gap.
//  2. Cancel is real: it answers `{ submitted: false }` rather than doing nothing. `submitted` is
//     the discriminator that lets the agent distinguish "the user declined" from "the user never
//     answered" (a timeout, which arrives as no answer at all).
//
// The payload is Zod-validated server-side regardless of anything decided here.

import { useCallback, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AskState, FormField, FormSpec } from "../types";

export interface AskFormProps {
  askId: string;
  form: FormSpec;
  status: AskState["status"];
  /** Receives the coerced values — numbers as numbers, toggles as booleans. */
  onSubmit: (values: Record<string, unknown>) => void;
  /** Answers `{ submitted: false }`. Wired by AskCard; never a no-op. */
  onCancel: () => void;
  className?: string;
}

/** Editing state is kept as raw strings so a half-typed number does not round-trip through NaN. */
type Draft = Record<string, unknown>;

function initialDraft(fields: readonly FormField[]): Draft {
  const draft: Draft = {};
  for (const f of fields) {
    if (f.value !== undefined) {
      draft[f.id] = f.type === "multiselect" && !Array.isArray(f.value) ? [f.value] : f.value;
      continue;
    }
    draft[f.id] = f.type === "toggle" ? false : f.type === "multiselect" ? [] : "";
  }
  return draft;
}

/**
 * Is this field answered?
 *
 * A `toggle` is ALWAYS answered — `false` is a real answer, and treating it as empty would make a
 * required opt-out box impossible to submit.
 */
function isFilled(field: FormField, value: unknown): boolean {
  switch (field.type) {
    case "toggle":
      return true;
    case "multiselect":
      return Array.isArray(value) && value.length > 0;
    case "number":
      return typeof value === "string" ? value.trim() !== "" && Number.isFinite(Number(value)) : typeof value === "number" && Number.isFinite(value);
    default:
      return typeof value === "string" ? value.trim() !== "" : value != null;
  }
}

/** Draft → wire. Only the coercion happens here; the server still validates. */
function coerce(fields: readonly FormField[], draft: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = draft[f.id];
    if (f.type === "number") {
      const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
      out[f.id] = Number.isFinite(n) && String(raw ?? "").trim() !== "" ? n : null;
    } else if (f.type === "toggle") {
      out[f.id] = raw === true;
    } else if (f.type === "multiselect") {
      out[f.id] = Array.isArray(raw) ? raw : [];
    } else {
      const s = typeof raw === "string" ? raw.trim() : raw == null ? "" : String(raw);
      out[f.id] = s === "" ? null : s;
    }
  }
  return out;
}

export function AskForm({ askId, form, status, onSubmit, onCancel, className }: AskFormProps) {
  const [draft, setDraft] = useState<Draft>(() => initialDraft(form.fields));

  // See ChoiceButtons: locked on the ask status only, never on `runActive` (§9.2 deadlock).
  const locked = status !== "pending";
  const submitting = status === "submitting";

  const set = useCallback((id: string, value: unknown) => {
    setDraft((d) => ({ ...d, [id]: value }));
  }, []);

  const allValid = useMemo(
    () => form.fields.every((f) => !f.required || isFilled(f, draft[f.id])),
    [form.fields, draft],
  );

  return (
    <div className={cn("space-y-3", className)}>
      {form.fields.map((f) => {
        const fieldId = `ask-${askId}-field-${f.id}`;
        const value = draft[f.id];
        return (
          <div key={f.id} className="space-y-1.5">
            {/* A toggle labels itself inline; everything else gets a label above the control. */}
            {f.type !== "toggle" && (
              <Label
                id={`${fieldId}-label`}
                // A multiselect is a group of checkboxes, so there is no single control for
                // `htmlFor` to point at — the group references this label by id instead.
                htmlFor={f.type === "multiselect" ? undefined : fieldId}
                className="text-xs"
              >
                {f.label}
                {f.required && (
                  <span aria-hidden className="text-muted-foreground">
                    *
                  </span>
                )}
              </Label>
            )}

            {f.type === "textarea" && (
              <Textarea
                id={fieldId}
                value={String(value ?? "")}
                placeholder={f.placeholder}
                required={f.required}
                disabled={locked}
                onChange={(e) => set(f.id, e.target.value)}
              />
            )}

            {(f.type === "text" || f.type === "number" || f.type === "date" || f.type === "url") && (
              <Input
                id={fieldId}
                type={f.type === "text" ? "text" : f.type}
                value={String(value ?? "")}
                placeholder={f.placeholder}
                required={f.required}
                disabled={locked}
                onChange={(e) => set(f.id, e.target.value)}
              />
            )}

            {f.type === "select" && (
              <Select
                value={value === "" || value == null ? null : String(value)}
                disabled={locked}
                onValueChange={(v) => set(f.id, typeof v === "string" ? v : "")}
              >
                <SelectTrigger id={fieldId} className="w-full">
                  <SelectValue placeholder={f.placeholder ?? "Choose…"} />
                </SelectTrigger>
                <SelectContent>
                  {(f.options ?? []).map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {f.type === "multiselect" && (
              <div
                className="flex flex-wrap gap-x-4 gap-y-2 pt-0.5"
                role="group"
                aria-labelledby={`${fieldId}-label`}
              >
                {(f.options ?? []).map((o) => {
                  const selected = Array.isArray(value) && value.includes(o);
                  return (
                    <Label
                      key={o}
                      className="text-xs font-normal"
                      htmlFor={`${fieldId}-${o}`}
                    >
                      <Checkbox
                        id={`${fieldId}-${o}`}
                        checked={selected}
                        disabled={locked}
                        onCheckedChange={(checked) => {
                          const current = Array.isArray(value) ? (value as unknown[]) : [];
                          set(
                            f.id,
                            checked === true ? [...current, o] : current.filter((x) => x !== o),
                          );
                        }}
                      />
                      {o}
                    </Label>
                  );
                })}
              </div>
            )}

            {f.type === "toggle" && (
              <Label htmlFor={fieldId} className="text-xs font-normal">
                <Switch
                  id={fieldId}
                  checked={value === true}
                  disabled={locked}
                  onCheckedChange={(checked) => set(f.id, checked === true)}
                />
                {f.label}
                {f.required && (
                  <span aria-hidden className="text-muted-foreground">
                    *
                  </span>
                )}
              </Label>
            )}

            {f.help && <p className="text-xs leading-snug text-muted-foreground">{f.help}</p>}
          </div>
        );
      })}

      <div className="flex items-center gap-2 pt-0.5">
        <Button
          size="sm"
          // `allValid` is the whole point of §9.6: the agent is blocked and cannot ask again
          // cheaply, so a half-filled object must never reach it.
          disabled={locked || !allValid}
          onClick={() => onSubmit(coerce(form.fields, draft))}
        >
          {submitting && <Loader2 className="size-4 animate-spin" />}
          {form.submitLabel ?? "Submit"}
        </Button>
        {/* A real Cancel — answers `{submitted:false}`, which is NOT the same as never answering. */}
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground"
          disabled={locked}
          onClick={onCancel}
        >
          {form.cancelLabel ?? "Cancel"}
        </Button>
      </div>
    </div>
  );
}
