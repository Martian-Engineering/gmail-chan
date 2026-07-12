import {
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  listGmailAccountIds,
  resolveDefaultGmailAccountId,
  resolveGmailAccount,
  type GmailCoreConfig,
  type ResolvedGmailAccount,
} from "./accounts.js";
import { gmailConfigSchema } from "./config.js";
import { normalizeGmailTarget, parseGmailTarget } from "./target.js";

export const GMAIL_CHANNEL_ID = "gmail" as const;

/** Gmail channel contract used by OpenClaw during discovery and setup. */
export const gmailPlugin: ChannelPlugin<ResolvedGmailAccount> =
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
      configSchema: gmailConfigSchema,
      config: {
        listAccountIds: (cfg) => listGmailAccountIds(cfg as GmailCoreConfig),
        defaultAccountId: (cfg) =>
          resolveDefaultGmailAccountId(cfg as GmailCoreConfig),
        resolveAccount: (cfg, accountId) =>
          resolveGmailAccount({
            cfg: cfg as GmailCoreConfig,
            ...(accountId !== undefined ? { accountId } : {}),
          }),
        isConfigured: (account) => account.configured,
        isEnabled: (account) => account.enabled,
        resolveAllowFrom: ({ cfg, accountId }) =>
          resolveGmailAccount({
            cfg: cfg as GmailCoreConfig,
            ...(accountId !== undefined ? { accountId } : {}),
          }).allowFrom,
        describeAccount: (account) => ({
          accountId: account.accountId,
          name: account.name ?? account.email,
          enabled: account.enabled,
          configured: account.configured,
        }),
      },
      messaging: {
        targetPrefixes: ["gmail"],
        normalizeTarget: (value) => normalizeGmailTarget(value) ?? undefined,
        inferTargetChatType: () => "group",
        targetResolver: {
          looksLikeId: (value) => parseGmailTarget(value) !== null,
          hint: "<thread:gmail-thread-id|mailto:email-address>",
        },
      },
    },
  });
