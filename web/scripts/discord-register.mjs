#!/usr/bin/env node
// Registers the /searchops slash command with Discord. Run once per app (or per command change):
//   node scripts/discord-register.mjs
// Needs DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in the environment.

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (!appId || !token) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN first.");
  process.exit(1);
}

const command = {
  name: "searchops",
  description: "Talk to the SearchOps agent",
  options: [{
    type: 3, // STRING
    name: "input",
    description: "audit example.com · use example.com · link you@x.com · or just ask",
    required: true,
  }],
};

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bot ${token}` },
  body: JSON.stringify(command),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Discord rejected the registration (${res.status}):`, data);
  process.exit(1);
}
console.log(`Registered /searchops — id ${data.id}. Point the app's Interactions Endpoint URL at <APP_URL>/api/discord/interactions.`);
