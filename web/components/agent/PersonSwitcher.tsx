"use client";

// The superuser's "whose chats am I looking at" control.
//
// Renders NOTHING for everyone else. Not disabled, not greyed out — absent. A control that appears
// and refuses is an invitation to ask why, and the answer would be "you cannot read your colleagues'
// conversations", which is a worse thing to put in the UI than silence. The server refuses the
// request regardless (SUPERUSER_EMAILS gates every route); this only decides whether the affordance
// is drawn at all.
//
// While viewing someone else the rail is READ-ONLY, and this component is where that is stated. The
// composer is disabled by the page, but a banner that says why is what stops it reading as a bug.

import { useEffect, useState } from "react";
import { Eye, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export interface HermesPerson {
  user_email: string;
  sessions: number;
  last_active: string;
}

export interface PersonSwitcherProps {
  /** Whose chats are on screen. null = your own. */
  viewingAs: string | null;
  onChange: (email: string | null) => void;
}

export function PersonSwitcher({ viewingAs, onChange }: PersonSwitcherProps) {
  const [people, setPeople] = useState<HermesPerson[] | null>(null);
  /** Undrawn until the server confirms superuser. Starts false so the default state is "no control". */
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch("/api/hermes/sessions?people=1");
        // 403 is the ordinary answer for everyone who is not the superuser. It is not an error
        // worth surfacing — it is the feature working.
        if (!res.ok) return;
        const r = await res.json().catch(() => null);
        if (!live || !r?.ok || !Array.isArray(r.people)) return;
        setPeople(r.people);
        setAllowed(true);
      } catch {
        /* offline or refused: leave the control undrawn */
      }
    })();
    return () => { live = false; };
  }, []);

  if (!allowed || !people) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <Select
        value={viewingAs ?? "__me__"}
        onValueChange={(v) => onChange(v === "__me__" ? null : v)}
      >
        <SelectTrigger className="h-8 text-xs" aria-label="View another person's conversations">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__me__">My conversations</SelectItem>
          {people.map((p) => (
            <SelectItem key={p.user_email} value={p.user_email}>
              {/* The local part alone: a rail 240px wide cannot show a full address, and everyone
                  here shares one domain, so the half that differs is the half worth showing. */}
              {p.user_email.split("@")[0]} · {p.sessions}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {viewingAs && (
        <div className="flex items-start gap-1.5 rounded-md border border-highlight/40 bg-highlight/10 px-2 py-1.5 text-xs">
          <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            Reading <b className="break-all">{viewingAs}</b>. You cannot reply in their conversations.
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 shrink-0"
            onClick={() => onChange(null)}
            aria-label="Back to my conversations"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
