// Free mailbox verification — no vendor credits, no metered API.
//
// This exists because Reoon sat at 0 credits while `verifyEmail()` and `verifyEmailsBulk()` had no
// working fallback: verify.ts fell back to a local SMTP probe that is "blocked on most serverless
// hosts" (i.e. always, on Vercel), and verifyBulk.ts had no fallback at all. Every constructed
// address in the cascade therefore came back `unknown`, was tagged `pattern` instead of
// `pattern-verified`, and was held by the send gate. The funnel was starving on a $0 problem.
//
// Two routes, picked by the domain's MX record:
//   microsoft — mailbox existence over plain HTTPS. Needs NO port 25, so it works from Vercel.
//   smtp      — RCPT TO probe. Needs port 25, so it runs on the droplet (via Hermes) or locally.
//
// ── What the measurements taught us (2026-08-26, real hosts) ────────────────────────────────────
// A naive "550 means the mailbox is invalid" is WRONG and actively dangerous. Measured:
//   moz.com        (Google)   → 550 5.1.1 NoSuchUser          ... a real answer: no such mailbox
//   forbes.com     (Mimecast) → 550 Listed by PBL, spamhaus   ... OUR PROBE was refused
//   microsoft.com  (M365)     → 550 5.7.1 Service unavailable, Client host blocked using Spamhaus
//   theverge.com   (Google)   → 250 on a random address       ... catch-all, proves nothing
//   imagine.art    (Google)   → 250 on a random address       ... our own domain is catch-all too
// Scoring those middle two as "invalid" would have deleted good prospects on the strength of our
// own IP reputation. So `classifySmtpReply` separates a statement about the MAILBOX from a
// statement about the PROBE — the same distinction verifyBulk.ts already draws between a verdict
// and "unchecked", pushed down to the SMTP reply code.
//
// Two consequences worth knowing before reading a verdict:
//   - A random CONTROL address is always probed alongside the target. A 250 on the target means
//     nothing until the control has been refused; both 250 means catch-all. This is what the paid
//     verifiers do internally, and it is what caught imagine.art and theverge.com above.
//   - Probes from a residential/PBL-listed IP get refused by reputation-sensitive hosts (that is
//     the forbes/microsoft result above). A datacenter IP does better, which is the real reason
//     the SMTP route belongs on the droplet rather than on a laptop.
import { promises as dnsPromises } from "node:dns";
import net from "node:net";
import { registrableDomain } from "@/lib/util/domain";

/** Verdict shape is structurally compatible with Reoon's (safe/catchAll/score/status) so it drops
 *  straight into the existing verifyBulk.ts machinery, plus `provider` so the detail line can name
 *  whichever route actually answered instead of always saying "Reoon". */
export interface MailboxVerdict {
  safe: boolean;
  catchAll: boolean;
  score: number;
  status: string;
  provider?: string;
}

export type MailProvider = "microsoft" | "google" | "mimecast" | "proofpoint" | "other" | "none";

// ── MX routing ──────────────────────────────────────────────────────────────────────────────────

/** Which mail platform hosts this domain, from its MX hostnames. Pure, so the selfcheck can pin
 *  it. Only `microsoft` changes the route; the rest are recorded because knowing the platform is
 *  what lets us explain a refusal later ("Mimecast refused the probe" beats "unknown"). */
export function mailProviderFromMx(hosts: string[]): MailProvider {
  if (!hosts.length) return "none";
  const h = hosts.join(" ").toLowerCase();
  // *.mail.protection.outlook.com is the M365 tenant inbound; olc.protection is the consumer side.
  if (/\.protection\.outlook\.com|\boutlook\.com|\bhotmail\b/.test(h)) return "microsoft";
  if (/aspmx.*\.google\.com|\bgooglemail\.com|smtp\.google\.com|\bgoogle\.com/.test(h)) return "google";
  if (/\bmimecast\b/.test(h)) return "mimecast";
  if (/\bpphosted\b|\bproofpoint\b/.test(h)) return "proofpoint";
  return "other";
}

export interface MxInfo { hosts: string[]; provider: MailProvider }

/**
 * MX hosts in priority order. Returns null when DNS itself failed — that is "we could not check",
 * which must never be conflated with `{ hosts: [] }`, which is the domain genuinely having no mail
 * server. The load-honesty rule applies to free sources exactly as it does to paid ones.
 */
export async function lookupMx(domain: string): Promise<MxInfo | null> {
  try {
    const recs = await dnsPromises.resolveMx(domain);
    const hosts = recs
      .sort((a, b) => a.priority - b.priority)
      .map((r) => r.exchange.replace(/\.$/, "").toLowerCase())
      .filter(Boolean);
    return { hosts, provider: mailProviderFromMx(hosts) };
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    // NXDOMAIN / no MX record are real answers about the domain, not a lookup failure.
    if (code === "ENOTFOUND" || code === "ENODATA") return { hosts: [], provider: "none" };
    return null;
  }
}

// ── SMTP reply classification ───────────────────────────────────────────────────────────────────

/** What a single RCPT TO reply actually PROVES. See the measurement table at the top of the file:
 *  this function is the guard against scoring our own IP reputation as a bad mailbox. Pure. */
export type SmtpOutcome = "accepted" | "no-such-mailbox" | "probe-refused" | "unclear";

export function classifySmtpReply(code: number, reply: string): SmtpOutcome {
  const r = (reply || "").toLowerCase();
  // 250 OK / 251 will-forward. 252 is "cannot verify, but would accept" — an explicit refusal to
  // answer, so it proves nothing.
  if (code === 250 || code === 251) return "accepted";
  if (code === 252) return "unclear";

  // Reputation, policy and rate-limit refusals are about US, not the mailbox. Checked BEFORE the
  // mailbox patterns because hosts mix the vocabulary: forbes.com answered 550 (a "permanent"
  // code) for a Spamhaus listing, which is not permanent and not about the recipient.
  if (/spamhaus|\bpbl\b|\bsbl\b|\bxbl\b|blocked|blacklist|block list|denied|not authori|unauthori|policy|reputation|rate limit|too many|try again|greylist|grey-list|temporarily|deferred|4\.\d+\.\d+/.test(r)) {
    return "probe-refused";
  }
  // 4xx is transient by definition — greylisting, load shedding. Never a verdict.
  if (code >= 400 && code < 500) return "probe-refused";

  // Enhanced status 5.1.0/5.1.1 is "bad destination mailbox address" — the answer we came for.
  if (/5\.1\.[01]|nosuchuser|no such user|user unknown|unknown user|user not found|recipient not found|recipient rejected|does not exist|no such recipient|invalid recipient|invalid address|mailbox unavailable|mailbox not found|address rejected/.test(r)) {
    return "no-such-mailbox";
  }
  // 5.7.x is "delivery not authorized" — a policy refusal wearing a 5xx.
  if (/5\.7\.\d+/.test(r)) return "probe-refused";
  if (code >= 500 && code < 600) return "unclear";
  return "unclear";
}

/** Fold a (target, control) outcome pair into a verdict. Pure, and the heart of the design: a
 *  target acceptance is only meaningful once the control has been REFUSED. */
export function foldSmtpOutcomes(target: SmtpOutcome, control: SmtpOutcome, provider: string): MailboxVerdict {
  // The control was accepted → the host accepts anything → an acceptance proves nothing.
  if (control === "accepted") {
    return { safe: false, catchAll: true, score: 0, status: "catch_all", provider };
  }
  if (target === "accepted") {
    // Control refused, target accepted: the host discriminates, and it said yes.
    return { safe: true, catchAll: false, score: 95, status: "safe", provider };
  }
  if (target === "no-such-mailbox") {
    return { safe: false, catchAll: false, score: 0, status: "invalid", provider };
  }
  // Our probe never got a straight answer. Explicitly NOT "invalid".
  return { safe: false, catchAll: false, score: 0, status: target === "probe-refused" ? "probe_refused" : "unknown", provider };
}

// ── SMTP route ──────────────────────────────────────────────────────────────────────────────────

const HELO_NAME = () => process.env.EMAIL_VERIFY_HELO || (FROM_ADDRESS().split("@")[1] ?? "localhost");
// A real, SPF-covered sender: some hosts check the MAIL FROM domain before answering RCPT.
const FROM_ADDRESS = () => process.env.EMAIL_VERIFY_FROM || process.env.SMTP_FROM_EMAIL || "postmaster@localhost";

interface SmtpReply { code: number; text: string }

/**
 * Run one SMTP conversation and return every reply in order. A fixed command sequence (proven in
 * the measurement above) rather than an adaptive dialogue: we always want both the target and the
 * control, so there is nothing to adapt.
 */
function smtpConverse(host: string, commands: string[], timeoutMs: number): Promise<{ replies: SmtpReply[]; error: string | null }> {
  return new Promise((resolve) => {
    const replies: SmtpReply[] = [];
    let step = -1; // -1 = waiting on the server greeting
    let buf = "";
    let settled = false;
    const sock = net.createConnection({ host, port: 25 });
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* already gone */ }
      resolve({ replies, error });
    };
    sock.setTimeout(timeoutMs, () => finish("timeout"));
    sock.on("error", (e: Error) => finish(e.message));
    sock.on("close", () => finish(null));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      // An SMTP reply may span lines: "250-first" continuations then a final "250 last".
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3} /.test(last)) return; // not a final line yet
      replies.push({ code: Number(last.slice(0, 3)), text: lines.join(" ").slice(0, 300) });
      buf = "";
      step++;
      if (step >= commands.length) return finish(null);
      sock.write(commands[step] + "\r\n");
    });
  });
}

/** Probe one mailbox plus a random control at the same domain, in a single connection. */
export async function verifyViaSmtpDirect(email: string, mxHost: string): Promise<MailboxVerdict | null> {
  const domain = email.split("@")[1];
  if (!domain) return null;
  const control = `zz-no-such-user-${Math.random().toString(36).slice(2, 12)}@${domain}`;
  const { replies, error } = await smtpConverse(
    mxHost,
    [`EHLO ${HELO_NAME()}`, `MAIL FROM:<${FROM_ADDRESS()}>`, `RCPT TO:<${email}>`, `RCPT TO:<${control}>`, "QUIT"],
    20_000,
  );
  // replies[0]=greeting, [1]=EHLO, [2]=MAIL FROM, [3]=RCPT target, [4]=RCPT control
  const targetReply = replies[3];
  const controlReply = replies[4];
  if (!targetReply) {
    // Never reached RCPT — connection refused, blocked port, host hung up on EHLO. Says nothing.
    return { safe: false, catchAll: false, score: 0, status: "probe_refused", provider: `smtp:${error ?? "no answer"}` };
  }
  const target = classifySmtpReply(targetReply.code, targetReply.text);
  const ctrl = controlReply ? classifySmtpReply(controlReply.code, controlReply.text) : "unclear";
  return foldSmtpOutcomes(target, ctrl, "smtp");
}

/**
 * The droplet leg of the SMTP route. Returns null when Hermes could not be used at all — not
 * configured, HTTP error, or it never reached RCPT — so the caller can fall through to a local
 * attempt. A Hermes that is reachable but has no /v1/verify deployed yet 404s, which lands here as
 * null and degrades to a local probe. It must never degrade to a false "invalid".
 *
 * Hermes returns raw SMTP replies and we classify them here, so `classifySmtpReply` stays the one
 * implementation of that rule (the Python side says the same in its docstring).
 */
async function verifyViaHermes(email: string, mxHost: string, onError?: (m: string) => void): Promise<MailboxVerdict | null> {
  const base = (process.env.HERMES_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  const token = process.env.HERMES_TOKEN;
  try {
    const res = await fetch(`${base}/v1/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ email, mx: mxHost }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) { onError?.(`hermes /v1/verify HTTP ${res.status}`); return null; }
    const d = await res.json();
    const t = d?.target as { code?: number; reply?: string } | null | undefined;
    if (!t || typeof t.code !== "number") {
      onError?.(`hermes /v1/verify reached no RCPT (${d?.error ?? "no reply"})`);
      return null;
    }
    const c = d?.control as { code?: number; reply?: string } | null | undefined;
    const target = classifySmtpReply(t.code, t.reply ?? "");
    const control = c && typeof c.code === "number" ? classifySmtpReply(c.code, c.reply ?? "") : "unclear";
    return foldSmtpOutcomes(target, control, "smtp-hermes");
  } catch (e: unknown) {
    onError?.(`hermes /v1/verify unreachable: ${(e as Error)?.message ?? "network error"}`);
    return null;
  }
}

/**
 * The SMTP route, preferring the droplet over the local process.
 *
 * Hermes first when configured: the droplet has a datacenter IP that reputation-sensitive hosts
 * actually answer, and on Vercel port 25 is blocked outright so a local attempt cannot work at all.
 * Falls through to a direct local probe, which is what makes this usable in dev today.
 */
export async function verifyViaSmtp(email: string, mxHost: string, onError?: (m: string) => void): Promise<MailboxVerdict | null> {
  return (await verifyViaHermes(email, mxHost, onError)) ?? verifyViaSmtpDirect(email, mxHost);
}

// ── Microsoft route (HTTPS, no port 25) ─────────────────────────────────────────────────────────

/** Microsoft's `IfExistsResult`: 0 = mailbox exists, 1 = does not, 5/6 = federated or a different
 *  identity provider (so the tenant is not answering for it). Pure. A non-zero ThrottleStatus
 *  means we were rate-limited and the body is not an answer. */
export function mapMicrosoftResult(ifExists: unknown, throttleStatus: unknown): MailboxVerdict {
  const p = "microsoft";
  if (typeof throttleStatus === "number" && throttleStatus !== 0) {
    return { safe: false, catchAll: false, score: 0, status: "probe_refused", provider: `${p}:throttled` };
  }
  if (ifExists === 0) return { safe: true, catchAll: false, score: 90, status: "safe", provider: p };
  if (ifExists === 1) return { safe: false, catchAll: false, score: 0, status: "invalid", provider: p };
  // 5 = federated to another IdP, 6 = managed elsewhere. The tenant declined to say.
  return { safe: false, catchAll: false, score: 0, status: "unknown", provider: `${p}:ifexists=${String(ifExists)}` };
}

async function msExists(email: string): Promise<{ ifExists: unknown; throttle: unknown } | null> {
  try {
    const res = await fetch("https://login.microsoftonline.com/common/GetCredentialType", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ Username: email }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const d = await res.json();
    return { ifExists: d?.IfExistsResult, throttle: d?.ThrottleStatus };
  } catch {
    return null;
  }
}

/**
 * Microsoft-hosted mailbox existence over HTTPS. Control-probed for the same reason the SMTP route
 * is: tenants can enable user-existence hiding, and a tenant that answers "exists" for a random
 * address is telling us nothing. Two calls per domain, and the domain-level result is what callers
 * should cache.
 */
export async function verifyViaMicrosoft(email: string, onError?: (m: string) => void): Promise<MailboxVerdict | null> {
  const domain = email.split("@")[1];
  if (!domain) return null;
  const target = await msExists(email);
  if (!target) { onError?.("microsoft GetCredentialType did not answer"); return null; }
  const verdict = mapMicrosoftResult(target.ifExists, target.throttle);
  // Only an "exists" needs disproving; a "does not exist" is already the discriminating answer.
  if (verdict.status !== "safe") return verdict;
  const control = await msExists(`zz-no-such-user-${Math.random().toString(36).slice(2, 12)}@${domain}`);
  if (!control) return { ...verdict, score: 70, provider: "microsoft:uncontrolled" };
  const controlVerdict = mapMicrosoftResult(control.ifExists, control.throttle);
  if (controlVerdict.status === "safe") {
    // The tenant claims a random address exists → existence is hidden. Unprovable, like catch-all.
    return { safe: false, catchAll: true, score: 0, status: "catch_all", provider: "microsoft:hides-existence" };
  }
  return verdict;
}

// ── The free entry point ────────────────────────────────────────────────────────────────────────

/**
 * Verify an address using only free routes. Returns null when no route could even be attempted
 * (DNS failure), which callers must render as "couldn't check" — never as a bad address.
 */
export async function verifyFree(email: string, onError?: (m: string) => void): Promise<MailboxVerdict | null> {
  const domain = (email.split("@")[1] ?? "").toLowerCase();
  if (!domain) return null;
  const mx = await lookupMx(domain);
  if (!mx) { onError?.(`MX lookup failed for ${domain}`); return null; }
  if (!mx.hosts.length) {
    // No MX at all: nothing can receive mail here. A real, free, definitive answer.
    return { safe: false, catchAll: false, score: 0, status: "invalid", provider: "dns:no-mx" };
  }
  if (mx.provider === "microsoft") {
    const v = await verifyViaMicrosoft(email, onError);
    // A Microsoft tenant that would not answer still has an SMTP door worth trying.
    if (v && v.status !== "unknown") return v;
  }
  return verifyViaSmtp(email, mx.hosts[0], onError);
}

/** The registrable mail domain, for domain-level caching of catch-all and route decisions. */
export function mailDomainOf(email: string): string {
  return registrableDomain(email.split("@")[1] ?? "");
}
