#!/usr/bin/env node
// Simulate a signed Slack request against a local server.
//
// Slack calls you, so testing normally needs a public tunnel, a workspace and an installed app —
// three things that fail independently and produce the same symptom (nothing happens). This signs a
// request the same way Slack does and posts it straight at localhost, so the route, the signature
// check, the identity lookup and the execution path can be proved before any of that exists.
//
//   node scripts/slack-sim.mjs command "check the pricing page"
//   node scripts/slack-sim.mjs mention  "audit https://example.com"
//   node scripts/slack-sim.mjs confirm  <action_id>
//   node scripts/slack-sim.mjs decline  <action_id>
//   node scripts/slack-sim.mjs badsig   "should be rejected"
import crypto from "node:crypto";
import fs from "node:fs";

// .env.local first: it is what `next dev` actually loads, so a secret set there and not in .env is
// the difference between this script agreeing with the server and silently disagreeing with it.
for (const f of [".env.local", ".env"]) {
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const BASE = process.env.SLACK_SIM_BASE || "http://localhost:3000";
const SECRET = process.env.SLACK_SIGNING_SECRET;
const TEAM = process.env.SLACK_SIM_TEAM || "T_TEST";
const CHANNEL = process.env.SLACK_SIM_CHANNEL || "C_TEST";
const USER = process.env.SLACK_SIM_USER || "U_TEST";

if (!SECRET) {
  console.error("SLACK_SIGNING_SECRET is not set (checked env, .env.local, .env).");
  console.error("Set any value — the server and this script only have to agree with each other.");
  process.exit(1);
}

const [mode, ...rest] = process.argv.slice(2);
const arg = rest.join(" ");
if (!mode) { console.error("usage: slack-sim.mjs <command|mention|confirm|decline|badsig> <text|action_id>"); process.exit(1); }

function sign(body, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const sig = "v0=" + crypto.createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return { "x-slack-signature": sig, "x-slack-request-timestamp": String(ts) };
}

function commandBody(text) {
  return new URLSearchParams({
    token: "sim", team_id: TEAM, channel_id: CHANNEL, user_id: USER,
    command: "/searchops", text, response_url: "https://example.invalid/hook", trigger_id: "sim",
  }).toString();
}

function interactionBody(actionId, target) {
  const payload = {
    type: "block_actions",
    team: { id: TEAM }, user: { id: USER }, channel: { id: CHANNEL },
    message: { ts: "1700000000.000100" },
    actions: [{ action_id: `${actionId}:${target}`, value: target, type: "button" }],
  };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

function eventBody(text) {
  return JSON.stringify({
    type: "event_callback", team_id: TEAM, event_id: `Ev${Date.now()}`,
    event: {
      type: "app_mention", user: USER, channel: CHANNEL, text: `<@U_BOT> ${text}`,
      ts: String(Date.now() / 1000), event_ts: String(Date.now() / 1000),
    },
  });
}

const routes = {
  command: () => ["/api/slack/commands", commandBody(arg), "application/x-www-form-urlencoded"],
  mention: () => ["/api/slack/events", eventBody(arg), "application/json"],
  confirm: () => ["/api/slack/interactions", interactionBody("agent_approve", arg), "application/x-www-form-urlencoded"],
  decline: () => ["/api/slack/interactions", interactionBody("agent_decline", arg), "application/x-www-form-urlencoded"],
  badsig:  () => ["/api/slack/commands", commandBody(arg), "application/x-www-form-urlencoded"],
};

if (!routes[mode]) { console.error(`unknown mode: ${mode}`); process.exit(1); }
const [path, body, contentType] = routes[mode]();

// badsig signs with the wrong secret: a 401 here is the check WORKING. If this one succeeds, the
// endpoint is open to anyone on the internet and nothing else in this script matters.
const headers = mode === "badsig" ? sign(body, "wrong-secret") : sign(body);

const res = await fetch(BASE + path, { method: "POST", headers: { "content-type": contentType, ...headers }, body });
const text = await res.text();

console.log(`${mode} → ${res.status} ${res.statusText}`);
console.log(text.slice(0, 800) || "(empty body)");

if (mode === "badsig") {
  console.log(res.status === 401 ? "\n✓ bad signature rejected" : "\n✗ BAD SIGNATURE ACCEPTED — endpoint is open");
  process.exit(res.status === 401 ? 0 : 1);
}
if (!res.ok) {
  console.log("\n✗ request was rejected");
  process.exit(1);
}
// The routes answer instantly and work in after(); the real result lands in Slack (or the server
// log, here). A 200 means accepted, not finished — watch `next dev` output for what happened.
console.log("\nAccepted. The work runs in the background — watch the dev server log.");
