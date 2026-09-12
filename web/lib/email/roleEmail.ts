// Detects role / generic / org mailboxes (press@, pressinquiries@, info@, brand_licensing@,
// git@hf.co, no-reply@, …) that get scraped off sites and wrongly attached to many authors.
// We never want to pitch these — they're not a person, and one address ends up shared across
// dozens of authors, so we'd email the same inbox over and over.

// Whole local-part (separators stripped) equals one of these → generic.
const EXACT = new Set([
  "press", "pr", "media", "info", "information", "hello", "hi", "hey", "hola", "bonjour",
  "contact", "contactus", "enquiries", "enquiry", "inquiries", "inquiry", "ask",
  "editor", "editors", "editorial", "tips", "tip", "team", "support", "help", "helpdesk",
  "admin", "office", "hq", "marketing", "sales", "partnerships", "partnership", "partners",
  "brand", "branding", "licensing", "legal", "careers", "jobs", "hr", "recruiting", "billing",
  "accounts", "account", "noreply", "webmaster", "hostmaster", "abuse", "security", "privacy",
  "git", "api", "feedback", "newsletter", "community", "social", "advertise", "advertising",
  "ads", "sponsor", "sponsorship", "general", "subscribe", "newsroom", "news", "hello2",
  "mail", "email", "notifications", "notification", "no-reply", "donotreply", "postmaster",
  "staff", "subscription", "subscriptions", "subs", "developer", "dev", "devrel", "devs",
  "group", "groups", "reception", "welcome", "service", "services", "orders", "order",
  // inquiry / submission desks and other non-person mailboxes seen in the wild
  "submissions", "submission", "submit", "care", "customercare", "customerservice", "customer",
  "partner", "obits", "obituaries", "alerts", "alert", "bot",
  // product / plan / marketing-funnel mailboxes (e.g. plus@shopify.com, a footer CTA scraped
  // onto every author). Never a person; whole-local-part match only, so no name collisions.
  "plus", "pro", "premium", "enterprise", "business", "demo", "trial", "upgrade", "pricing",
  "signup", "getstarted", "start", "join", "invest", "investors", "ir", "affiliate", "affiliates",
]);
// Collapsed local-part contains one of these → generic (catches compound role addresses).
// Only DISTINCTIVE stems that can't appear inside a human name (never short/name-like tokens).
const CONTAINS = [
  "pressinquir", "pressoffice", "pressteam", "brandlicens", "adinquir", "mediarelation",
  "newsroom", "noreply", "donotreply", "do-not-reply", "mailerdaemon", "postmaster",
  "unsubscribe", "pressrelease", "mediateam", "presscontact", "subscription", "groupsubscri",
  "submiss", "inquir", "enquir", "editorial", "newsdesk", "customercare", "customerservice",
];

export function isRoleEmail(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const e = raw.replace(/^mailto:/i, "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1) return false;
  const local = e.slice(0, at).split("+")[0]; // drop +tag
  const collapsed = local.replace(/[^a-z0-9]/g, "");
  if (!collapsed) return true;
  if (EXACT.has(collapsed)) return true;
  return CONTAINS.some((s) => collapsed.includes(s));
}
