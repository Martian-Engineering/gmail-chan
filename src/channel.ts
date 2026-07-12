import {
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";

export const GMAIL_CHANNEL_ID = "gmail" as const;

export type GmailAccountPlaceholder = {
  accountId: string;
};

/** Gmail channel contract used by OpenClaw during discovery and setup. */
export const gmailPlugin: ChannelPlugin<GmailAccountPlaceholder> =
  createChatChannelPlugin({
    base: {
      id: GMAIL_CHANNEL_ID,
      meta: { ...getChatChannelMeta(GMAIL_CHANNEL_ID), id: GMAIL_CHANNEL_ID },
      capabilities: {
        chatTypes: ["group"],
        threads: true,
        blockStreaming: true,
      },
      reload: { configPrefixes: ["channels.gmail"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: (_cfg, accountId) => ({
          accountId: accountId ?? "default",
        }),
      },
    },
  });
