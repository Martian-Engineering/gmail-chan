import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  listGmailAccountIds,
  resolveDefaultGmailAccountId,
  resolveGmailAccount,
  type GmailCoreConfig,
  type ResolvedGmailAccount,
} from "./accounts.js";
import { gmailConfigSchema } from "./config.js";
import { startGmailGatewayAccount } from "./gateway.js";
import { createGmailClient } from "./gmail-client.js";
import { sendGmailText } from "./outbound.js";
import { getGmailRuntime } from "./runtime.js";
import { normalizeGmailTarget, parseGmailTarget } from "./target.js";

export const GMAIL_CHANNEL_ID = "gmail" as const;

const gmailMessageAdapter = defineChannelMessageAdapter({
  id: GMAIL_CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => {
      const account = resolveGmailAccount({
        cfg: ctx.cfg as GmailCoreConfig,
        ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
      });
      const result = await sendGmailText({
        account,
        client: createGmailClient(account),
        target: ctx.to,
        text: ctx.text,
        ...(ctx.replyToId ? { replyToId: ctx.replyToId } : {}),
      });
      const replyToId = ctx.replyToId ?? undefined;
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: GMAIL_CHANNEL_ID, messageId: result.messageId }],
          threadId: result.threadId,
          ...(replyToId ? { replyToId } : {}),
          kind: "text",
        }),
      };
    },
  },
});

/** Gmail channel contract used by OpenClaw during discovery and setup. */
export const gmailPlugin: ChannelPlugin<ResolvedGmailAccount> =
  createChatChannelPlugin({
    base: {
      id: GMAIL_CHANNEL_ID,
      meta: {
        id: GMAIL_CHANNEL_ID,
        label: "Gmail",
        selectionLabel: "Gmail (OAuth)",
        detailLabel: "Gmail",
        docsPath: "/channels/gmail",
        docsLabel: "gmail",
        blurb: "Use Gmail threads as isolated OpenClaw conversations.",
        systemImage: "envelope",
      },
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
      gateway: {
        startAccount: async (ctx) =>
          await startGmailGatewayAccount(ctx, getGmailRuntime()),
      },
      message: gmailMessageAdapter,
      messaging: {
        targetPrefixes: ["gmail"],
        normalizeTarget: (value) => normalizeGmailTarget(value) ?? undefined,
        inferTargetChatType: () => "group",
        targetResolver: {
          looksLikeId: (value) => parseGmailTarget(value) !== null,
          hint: "<thread:gmail-thread-id|mailto:email-address>",
        },
        resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
          const parsed = parseGmailTarget(target);
          if (!parsed) {
            return null;
          }
          const normalized = normalizeGmailTarget(target);
          if (!normalized) {
            return null;
          }
          return buildChannelOutboundSessionRoute({
            cfg,
            agentId,
            channel: GMAIL_CHANNEL_ID,
            ...(accountId !== undefined ? { accountId } : {}),
            recipientSessionExact:
              parsed.kind === "thread" ? true : "delivery-identity",
            peer: { kind: "channel", id: normalized },
            chatType: "channel",
            from: `gmail:${accountId ?? "default"}`,
            to: normalized,
            ...(parsed.kind === "thread" ? { threadId: parsed.threadId } : {}),
          });
        },
        resolveSessionConversation: ({ rawId }) => {
          const parsed = parseGmailTarget(rawId);
          if (!parsed || parsed.kind === "email") {
            return null;
          }
          const id = `thread:${parsed.threadId}`;
          return {
            id,
            threadId: parsed.threadId,
            baseConversationId: id,
            parentConversationCandidates: [id],
          };
        },
      },
    },
    outbound: {
      base: { deliveryMode: "direct" },
      attachedResults: {
        channel: GMAIL_CHANNEL_ID,
        sendText: async ({ cfg, to, text, accountId, replyToId }) => {
          const account = resolveGmailAccount({
            cfg: cfg as GmailCoreConfig,
            ...(accountId !== undefined ? { accountId } : {}),
          });
          const result = await sendGmailText({
            account,
            client: createGmailClient(account),
            target: to,
            text,
            ...(replyToId ? { replyToId } : {}),
          });
          return { messageId: result.messageId };
        },
      },
    },
  });
