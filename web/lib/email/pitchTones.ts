// The tone presets in the Rewrite popover, shared by the single-pitch revise and the
// workflow-wide apply so "the tone I picked on one prospect" means exactly the same thing when it
// runs across eighty.
//
// A fixed catalogue rather than free text, for the same reason SELECTABLE_MODELS is an allowlist:
// the id travels through two API routes and lands in a billed prompt, and an arbitrary string
// would make the batch apply a prompt-injection surface for whatever the client sends. Anything
// beyond these four belongs in the instruction box, which stays free text.
//
// Pure data — safe to import from client components (the directives are the only server-ish part,
// and they are just strings).
export const PITCH_TONES = [
  { id: "warm", label: "Warm", directive: "Make the tone warm and personable: sound genuinely interested in their work, never gushing." },
  { id: "direct", label: "Direct", directive: "Make the tone direct and brisk: shortest path to the ask, no softeners, no throat-clearing." },
  { id: "casual", label: "Casual", directive: "Make the tone casual and conversational: contractions, plain words, like a quick note to a peer." },
  { id: "formal", label: "Formal", directive: "Make the tone professional and courteous: complete sentences, measured, no slang." },
] as const;

export type PitchToneId = (typeof PITCH_TONES)[number]["id"];

export function isPitchTone(id: unknown): id is PitchToneId {
  return typeof id === "string" && PITCH_TONES.some((t) => t.id === id);
}

/** The prompt line for a tone id; null for absent/unknown ids so a stale or mistyped tone
 *  degrades to "no tone directive" instead of erroring a rewrite the person is waiting on. */
export function toneDirective(id: string | null | undefined): string | null {
  return PITCH_TONES.find((t) => t.id === id)?.directive ?? null;
}

export function toneLabel(id: string | null | undefined): string | null {
  return PITCH_TONES.find((t) => t.id === id)?.label ?? null;
}

// The LANGUAGE axis, kept as an allowlist for exactly the tone catalogue's reason: the id
// crosses API routes into a billed prompt, and free text there is a prompt-injection surface.
// English is the app-wide default; Roman Urdu exists because the WhatsApp vendor negotiations
// run in it (docs/WHATSAPP_CHANNEL_PLAN.md §5). Anything finer-grained ("more formal Urdu",
// "match his slang") belongs in the free-text instruction box, same as with tones.
export const PITCH_LANGS = [
  { id: "en", label: "English", directive: "Write in plain English." },
  { id: "roman_ur", label: "Roman Urdu", directive: "Write in Roman Urdu: Urdu in the latin alphabet, in the register of Pakistani business WhatsApp chats, aap-based, casual but respectful. Prices, numbers, URLs and site names stay exactly as they are. No Urdu script, and no English translation alongside." },
] as const;

export type PitchLangId = (typeof PITCH_LANGS)[number]["id"];

export function isPitchLang(id: unknown): id is PitchLangId {
  return typeof id === "string" && PITCH_LANGS.some((l) => l.id === id);
}

/** Null for absent/unknown ids — the drafter then tells the model to match the language the
 *  conversation is already in, which is the right default for a mixed-language thread. */
export function langDirective(id: string | null | undefined): string | null {
  return PITCH_LANGS.find((l) => l.id === id)?.directive ?? null;
}

export function langLabel(id: string | null | undefined): string | null {
  return PITCH_LANGS.find((l) => l.id === id)?.label ?? null;
}
