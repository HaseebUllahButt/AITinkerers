// The binding verbs every surface understands: `link` (tie this account to an email), `use`
// (bind this channel to a site), `where` (what is this channel bound to), `unuse` (unbind).
// They were Slack-only; pulling them here means a WhatsApp chat, a Discord channel and a
// Telegram group all bind a site with the same words and the same rules.
import {
  bindChannel, boundSite, findSite, linkSurfaceUser, surfaceHandle, unbindChannel,
  type Surface,
} from "./store";

export interface CommandReply {
  text: string;
  /** Whether the reply should be visible to the channel or only to the sender. */
  broadcast?: boolean;
}

const COMMAND = /^(link|use|where|unuse)(?:\s+(.+))?$/i;

export function matchBindingCommand(text: string): { verb: string; arg: string } | null {
  const m = COMMAND.exec(text.trim());
  return m ? { verb: m[1].toLowerCase(), arg: (m[2] ?? "").trim() } : null;
}

export async function handleBindingCommand(input: {
  surface: Surface;
  workspaceId: string;
  channelId: string;
  userId: string;
  verb: string;
  arg: string;
}): Promise<CommandReply> {
  const { surface, workspaceId, channelId, userId, verb, arg } = input;
  const actor = surfaceHandle(surface, workspaceId, userId);

  if (verb === "link") {
    const email = arg.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { text: "Use `link you@example.com`." };
    }
    await linkSurfaceUser(surface, workspaceId, userId, email, actor);
    return { text: `Linked this ${surface} account to ${email}.` };
  }

  const current = await boundSite(surface, workspaceId, channelId);
  if (verb === "where") {
    return { text: current
      ? `This channel follows *${current.brand || current.domain}* (${current.url}).`
      : "This channel is not bound. Use `use example.com`." };
  }
  if (verb === "unuse") {
    await unbindChannel(surface, workspaceId, channelId);
    return { text: "This channel no longer follows a site.", broadcast: true };
  }

  const site = await findSite(arg);
  if (!site) {
    return { text: `No saved site matches \`${arg}\`. Run it once from the audit page, then bind here.` };
  }
  await bindChannel(surface, workspaceId, channelId, site.id, actor);
  return {
    text: `This channel now follows *${site.brand || site.domain}* (${site.url}).`,
    broadcast: true,
  };
}
