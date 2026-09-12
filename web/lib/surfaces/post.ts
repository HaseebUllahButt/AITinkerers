// Post a plain-text message to a channel on any surface. Every adapter reports the same result
// shape so notify and the executor can fan out without knowing which surface they are writing to.
import { postChannelMessage } from "@/lib/discord/api";
import { postMessage } from "@/lib/slack/api";
import { sendTelegramMessage } from "@/lib/telegram/api";
import { sendWhatsApp } from "@/lib/whatsapp/api";
import type { Surface } from "./store";

export interface PostResult {
  ok: boolean;
  error?: string;
}

export async function postToChannel(
  surface: Surface, channelId: string, text: string,
): Promise<PostResult> {
  switch (surface) {
    case "slack": {
      const res = await postMessage(channelId, text);
      return { ok: res.ok, error: res.error };
    }
    case "discord":
      return postChannelMessage(channelId, text);
    case "telegram":
      return sendTelegramMessage(channelId, text);
    case "whatsapp":
      return sendWhatsApp(channelId, text);
  }
}
