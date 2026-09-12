// What people actually type into ImagineArt, and how to write an example prompt that reads like it.
//
// A client-safe leaf: no database, no Strapi, no server imports. The blog writer, Summer and the
// validator all read from here.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
//
// An answer engine quoting us on "how do I prompt for X" is quoting a concrete prompt, not a
// paragraph about prompting. Articles that carry real, copyable prompts get lifted; articles that
// say "be specific and describe the lighting" do not, because that sentence exists on ten thousand
// pages already. The prompt IS the citable unit.
//
// The failure mode this file prevents is the invented prompt that no human would type. Left to
// itself a model writes:
//
//     "A majestic golden retriever in a sunlit meadow, 8k, ultra-detailed, masterpiece"
//
// Nobody types that. It is a stock-photo caption with render tags bolted on, and it reads as
// synthetic to a person who has used these tools. The prompts below are shaped from what the product
// actually receives.
//
// ── Where the shapes came from ──────────────────────────────────────────────────────────────────
//
// Mixpanel, project 3287199 (Imagine Web - Prod), sampled 2026-09-08 over a 30-day window. The
// `prompt_text` property on the generation events carries the real prompt, so these are patterns
// read off live traffic rather than guessed. Volumes over that window:
//
//     Image Generation - One      893,828 generations   253,353 users    3.5% Premium
//     Video Generation - One      344,495 generations   171,807 users    3.9% Premium
//     Apps Generation - One        91,657 generations
//     Workflow Generation          72,390 generations     1,500 users   62%   Premium
//     Ad Generation - One           6,016 generations
//     AI Shorts Generation            995 generations
//
// Two of those numbers should change how you write. Image and Video are ~90% of all prompting, so an
// article about either is writing for the main road. And Workflows inverts the plan mix — 62% Premium
// against 3.5% everywhere else — so a Workflows article is addressing a professional who is paying,
// and the register moves accordingly.

/** A studio, its real prompt shape, and examples modelled on live traffic. */
export interface StudioPromptProfile {
  studio: string;
  /** The generation event this was read from, so a future reader can re-run the query. */
  event: string;
  /** How prompts in this studio are actually built. Written to be read by the model verbatim. */
  shape: string;
  /** Observed model / preset names. Real ones — never invent a model that is not on this list. */
  models: string[];
  /** Example prompts in the house of what people really send. */
  examples: string[];
}

export const STUDIO_PROMPTS: StudioPromptProfile[] = [
  {
    studio: "Image",
    event: "Image Generation - One",
    shape:
      "Bimodal, and both modes are common. Either a terse fragment with no styling at all ('one white shirt', " +
      "'create a image of girl with a book', 'design the interior for this kitchen'), or a long structured brief " +
      "that names the subject, the wardrobe, the setting, the camera and what must NOT change. The long ones " +
      "very often start with an instruction to preserve an uploaded reference — identity, faces, a product's " +
      "exact lettering — because the user is editing, not generating from nothing. Aspect ratio is left at 1:1 " +
      "far more often than the prompt's own intent implies.",
    models: [
      "Nano Banana 2", "Nano Banana Pro", "Nano Banana", "GPT Image 2", "Seedream v4.5",
      "ImagineArt 2.0", "ImagineArt 2.0 Edit", "Ideogram v3", "Dreamina 3.1", "xAI Grok Imagine", "V7",
    ],
    examples: [
      "design the interior for this kitchen",
      "I want this same girl on every page of my children's book. She can be in different positions like standing, walking etc.",
      "Edit this group photo into a professional school event photograph. Preserve the exact identity and original " +
        "facial features of every person. Do not regenerate, beautify or reshape any face. Keep the background.",
      "Create a premium photorealistic event poster for a Bangalore event called \"COFFEE RAVE\". Black-and-gold " +
        "masquerade styling, gold foil type, a coffee cup as the hero object, space at the bottom for the date.",
      "A warm minimalist flat illustration for a LinkedIn post. Two coffee cups on a wooden table, steam rising " +
        "from both, soft warm palette, lots of negative space.",
    ],
  },
  {
    studio: "Video",
    event: "Video Generation - One",
    shape:
      "Scene-by-scene with explicit timecodes ('SCENE 1 — 0-7 seconds'), even though the generated clip is " +
      "usually 4-5 seconds. People write a 20-second script and get five seconds back; that gap is a real, " +
      "citable thing to explain rather than something to hide. Uploaded assets are referenced inline with the " +
      "product's own @[Image1] syntax. 16:9 dominates. Camera direction is named explicitly — 'slow cinematic " +
      "push in', 'wide establishing shot'. Re-runs of an identical prompt three or four times in a row are " +
      "normal: that is someone re-rolling, not someone iterating.",
    models: [
      "Kling o3 Edit", "Kling 2.6 Pro", "Seedance 2.5", "Seedance 1.5 Pro", "Hailuo AI", "MiniMax Hailuo H3",
    ],
    examples: [
      "Epic trailer scene of warriors speaking before battle.",
      "A girl playing a dance tune on her violin in a sunlit room",
      "@[Image1] The camera moves slowly closer as the head tilts backward and the chin lifts. Hold the lighting " +
        "and the background exactly as they are.",
      "Slow cinematic push toward a black SUV parked in a polished concrete garage. Rain on the floor, cold key " +
        "light from the left, reflections on the bonnet. No people in frame.",
    ],
  },
  {
    studio: "Apps",
    event: "Apps Generation - One",
    shape:
      "Two populations. Most apps take NO prompt at all — Clothes Changer, Teeth Whitening, Image Combiner, " +
      "Hairstyle Changer are one-click on an upload, and an article that invents a prompt for them is wrong " +
      "about the product. The apps that DO take a prompt get a short imperative edit aimed at something already " +
      "on screen: no styling words, no camera, just the change. Avatar apps are the exception and take a spoken " +
      "script instead of a description.",
    models: ["Background Changer", "Video Background Changer", "Recolor", "AI Image Replace", "HeyGen Avatar IV"],
    examples: [
      "change gray to red",
      "Change the video background to a Halloween themed background",
      "Remove the arch completely, and apply that pattern to the top of the green wall instead",
      "Keep the tumbler completely unchanged — its lettering, artwork, colours, lid and proportions. Place it on " +
        "dark stone beside a waterfall.",
    ],
  },
  {
    studio: "Workflows",
    event: "Workflow Generation",
    shape:
      "The professional surface: 62% of its users are Premium against ~3.5% elsewhere, and it is the smallest " +
      "audience by user count of the big four. Prompts are per-node rather than per-image, often carry " +
      "variables, and are written to be run repeatedly over changing inputs rather than once. Write for someone " +
      "building a repeatable pipeline, not someone making one picture.",
    models: [],
    examples: [
      "Product shot on a seamless light-grey backdrop, soft top light, shadow directly beneath. Same framing every run.",
      "Rewrite {{caption}} as a single line under nine words, sentence case, no emoji.",
    ],
  },
  {
    studio: "AI Shorts",
    event: "AI Shorts Generation",
    shape:
      "The smallest studio by volume (995 generations in 30 days), and the only one where the prompt is a TOPIC " +
      "rather than a description — the product writes the script from it. It carries its own structured fields " +
      "for script_style, tone_of_voice, narrator accent and gender, caption styling and background music, so a " +
      "prompt that tries to specify those in prose is fighting the UI.",
    models: [],
    examples: [
      "Three things nobody tells you about your first month freelancing",
      "Why the Roman concrete recipe still outlasts modern cement",
    ],
  },
  {
    studio: "Ads",
    event: "Ad Generation - One",
    shape:
      "Has no prompt_text property at all — it is driven by structured choices (format, hook, scene, product, " +
      "avatar, template) rather than free text. Do not write a prompt example for the Ads studio; write about " +
      "the choices instead. Getting this wrong is the clearest tell that an article was written without opening " +
      "the product.",
    models: [],
    examples: [],
  },
];

/**
 * Patterns that are real, surprising, and therefore worth writing about.
 *
 * These are the things an article can say that a competitor's article cannot, because they come from
 * traffic rather than from imagining a user. Each one is a claim about behaviour we have observed —
 * usable as an observation, NOT as a statistic (see PROMPT_RULES).
 */
export const OBSERVED_BEHAVIOURS = [
  "People paste LLM output straight into the prompt box, preamble and all — prompts routinely begin " +
    "'Absolutely — here is the finished...' or 'Got it. Here's the corrected version:'. The model then has to " +
    "read past a chat response to find the description.",
  "People ask the Image studio for a video and the Video studio for a 20-second cut. The prompt describes " +
    "something the surface cannot produce, and the result disappoints for a reason that has nothing to do with " +
    "prompting skill.",
  "Aspect ratio is specified in the prompt text ('9:16 vertical') while the actual selector stays on 1:1. The " +
    "written instruction loses; the control wins.",
  "The same prompt is re-sent three or four times unchanged. That is re-rolling for a better sample, not " +
    "iterating — and it is a habit worth naming, because changing one clause usually beats re-rolling.",
  "A large share of long prompts are edits, not generations: they open by telling the model what to preserve " +
    "from an uploaded image, and the hard part is the negative constraint rather than the description.",
  "Prompts arrive in Hindi, Urdu, Spanish, French, Portuguese and Arabic as often as English on the consumer " +
    "surfaces, frequently mixed with English inside one sentence.",
];

/**
 * How to write an example prompt so it reads as real.
 *
 * Written to be handed to the model verbatim.
 */
export const PROMPT_RULES = [
  "Write prompts a person would actually type. The tell of a fake prompt is decoration: '8k, ultra-detailed, " +
    "masterpiece, trending on artstation' is a 2022 Stable Diffusion habit and nobody types it into this product.",
  "Vary the length deliberately. Real traffic is bimodal — some prompts are four words, some are two hundred. " +
    "An article where every example is a tidy 25-word sentence is the giveaway.",
  "Prefer a prompt with a job attached. 'A cat' teaches nothing; 'the same character on every page of a " +
    "children's book' is a problem a reader recognises, and it is what people actually ask for.",
  "Name only models that exist — the lists in STUDIO_PROMPTS are read from live traffic. An invented model name " +
    "is a factual error that outlives the article.",
  "Match the prompt to what the surface can do. Do not write a prompt example for the Ads studio, which takes " +
    "structured choices and no free text, and do not write one for a one-click app.",
  "Show the fix, not just the prompt. A before/after pair — the terse version, then the version that names the " +
    "lighting and what to preserve — is the shape answer engines quote, because it contains the reason.",
  "NEVER attribute an example prompt to a named person, a job title, a company, or a review. An example is " +
    "'a prompt like this', not 'one user told us'. The moment it carries a person it is a fabricated testimonial, " +
    "which is the one thing this house does not write.",
  "NEVER turn these behaviours into a statistic. You may write 'people often paste an entire ChatGPT reply into " +
    "the box'; you may not write '38% of users paste ChatGPT output'. The first is an observation, the second is " +
    "a number that would need a published source.",
  "Format a prompt as a fenced code block so it can be copied. A prompt buried in a paragraph cannot be used, " +
    "and an answer engine is far likelier to lift a block that stands alone.",
];

/** Studios that take no free-text prompt, so an example would misrepresent the product. */
export const NO_PROMPT_SURFACES = [
  "Ads (structured: format, hook, scene, product, avatar, template)",
  "One-click apps: Clothes Changer, Teeth Whitening, Image Combiner, Hairstyle Changer, Motion Control",
];

/**
 * Is this piece one where example prompts belong?
 *
 * Deliberately narrow. The note is long, and injecting it into every article is how a model learns
 * to skip a block — the same reasoning as the socials note. It fires on prompting itself, on a named
 * studio, on a named model, and on the generate/make/create phrasing that heads most tool-intent
 * queries. It does NOT fire on outreach, backlinks, SEO or company subjects.
 */
export function promptsRelevant(...text: (string | null | undefined)[]): boolean {
  const t = text.filter(Boolean).join(" ").toLowerCase();
  if (!t.trim()) return false;
  if (/\b(backlink|outreach|guest post|link build|newsletter|pricing page|funding|acquisition)\b/.test(t)) {
    // A commercial or company subject that merely contains the word "prompt" is not a prompting piece.
    if (!/\bprompt/.test(t)) return false;
  }
  if (/\bprompt(s|ing)?\b/.test(t)) return true;
  if (STUDIO_PROMPTS.some((s) => t.includes(s.studio.toLowerCase()))) return true;
  if (STUDIO_PROMPTS.some((s) => s.models.some((m) => t.includes(m.toLowerCase())))) return true;
  return /\b(generate|generator|make|create|turn .* into|how to (write|get))\b/.test(t)
    && /\b(image|video|photo|logo|avatar|thumbnail|poster|ad|short|animation|voice|music)\b/.test(t);
}

/**
 * The studio a subject is about, when it names one.
 *
 * Resolves through the MODEL lists as well as the studio names, because most pieces name a model
 * rather than a surface — "Nano Banana 2 prompt guide" is an Image-studio article and matching only
 * on the word "image" would hand it the whole catalogue instead of the one profile it needs.
 * Longest model name first, so "Nano Banana Pro" is not shadowed by "Nano Banana".
 */
export function studioMentioned(...text: (string | null | undefined)[]): string | undefined {
  const t = text.filter(Boolean).join(" ").toLowerCase();
  if (!t.trim()) return undefined;
  const byName = STUDIO_PROMPTS.find((s) => t.includes(s.studio.toLowerCase()));
  if (byName) return byName.studio;
  const byModel = STUDIO_PROMPTS
    .flatMap((s) => s.models.map((m) => ({ studio: s.studio, m: m.toLowerCase() })))
    .sort((a, b) => b.m.length - a.m.length)
    .find((x) => t.includes(x.m));
  return byModel?.studio;
}

/** The profile for one studio, by loose name match. */
export function studioProfile(name: string): StudioPromptProfile | undefined {
  const n = name.trim().toLowerCase();
  return STUDIO_PROMPTS.find(
    (s) => s.studio.toLowerCase() === n || s.event.toLowerCase().includes(n) || n.includes(s.studio.toLowerCase()),
  );
}

/**
 * The block handed to the writer when a draft is about prompting, a studio, or a model.
 *
 * Deliberately not injected into every article: a post about backlink outreach does not need the
 * Image studio's aspect-ratio habits, and an always-on block trains the model to ignore it.
 */
export function userPromptsNote(studio?: string): string {
  const picked = studio ? studioProfile(studio) : undefined;
  const profiles = picked ? [picked] : STUDIO_PROMPTS.filter((s) => s.examples.length);

  const body = profiles.map((p) => {
    const models = p.models.length ? `\n  Models people pick: ${p.models.join(", ")}.` : "";
    const ex = p.examples.length
      ? `\n  Real shapes:\n${p.examples.map((e) => `    - ${e}`).join("\n")}`
      : "\n  This surface takes no free-text prompt — do not invent one.";
    return `- ${p.studio} (${p.event})\n  ${p.shape}${models}${ex}`;
  }).join("\n\n");

  return [
    "## Example prompts, and making them read as real",
    "",
    "Concrete prompts are the citable unit of a prompting article — an answer engine lifts the prompt, not the",
    "paragraph about prompting. These shapes are read from live ImagineArt traffic (Mixpanel, 30 days to",
    "2026-09-08), so write examples that sit inside them.",
    "",
    body,
    "",
    "Worth writing about, because it is true of real traffic and no competitor's article says it:",
    ...OBSERVED_BEHAVIOURS.map((b) => `- ${b}`),
    "",
    "Rules:",
    ...PROMPT_RULES.map((r) => `- ${r}`),
  ].join("\n");
}

/** One-line reminder for the end of the writing turn, where the long note has scrolled away. */
export function userPromptsReminder(): string {
  return (
    "If this piece shows example prompts: make them look typed, not composed — vary the length, skip the " +
    "'8k ultra-detailed' decoration, put each in its own code block, name only models that exist, and never " +
    "attribute a prompt to a person or turn a behaviour into a percentage."
  );
}
