import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
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
import { recordOutboundThreadContext } from "./thread-context.js";
import {
  MAX_GMAIL_ATTACHMENT_BYTES,
  type RawEmailAttachment,
} from "./message.js";

export const GMAIL_CHANNEL_ID = "gmail" as const;

type GmailOutboundMediaContext = {
  mediaUrl: string;
  mediaAccess?: NonNullable<
    Parameters<typeof loadOutboundMediaFromUrl>[1]
  >["mediaAccess"];
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
};

async function loadGmailOutboundAttachment(
  ctx: GmailOutboundMediaContext,
): Promise<RawEmailAttachment> {
  const media = await loadOutboundMediaFromUrl(ctx.mediaUrl, {
    maxBytes: MAX_GMAIL_ATTACHMENT_BYTES,
    ...(ctx.mediaAccess ? { mediaAccess: ctx.mediaAccess } : {}),
    ...(ctx.mediaLocalRoots ? { mediaLocalRoots: ctx.mediaLocalRoots } : {}),
    ...(ctx.mediaReadFile ? { mediaReadFile: ctx.mediaReadFile } : {}),
  });
  return {
    filename: media.fileName ?? "attachment.bin",
    ...(media.contentType ? { contentType: media.contentType } : {}),
    data: media.buffer,
  };
}

async function rememberOutboundThread(params: {
  account: ResolvedGmailAccount;
  target: string;
  text: string;
  threadId: string;
}): Promise<void> {
  if (parseGmailTarget(params.target)?.kind !== "email") {
    return;
  }
  const runtime = getGmailRuntime();
  try {
    await recordOutboundThreadContext({
      runtime,
      accountId: params.account.accountId,
      threadId: params.threadId,
      text: params.text,
    });
  } catch (error) {
    runtime.logging
      .getChildLogger({ channel: GMAIL_CHANNEL_ID })
      .warn("Could not persist outbound Gmail thread context", {
        error: error instanceof Error ? error.message : String(error),
      });
  }
}

const gmailMessageAdapter = defineChannelMessageAdapter({
  id: GMAIL_CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
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
      await rememberOutboundThread({
        account,
        target: ctx.to,
        text: ctx.text,
        threadId: result.threadId,
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
    media: async (ctx) => {
      const account = resolveGmailAccount({
        cfg: ctx.cfg as GmailCoreConfig,
        ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
      });
      const attachment = await loadGmailOutboundAttachment(ctx);
      const result = await sendGmailText({
        account,
        client: createGmailClient(account),
        target: ctx.to,
        text: ctx.text,
        attachments: [attachment],
        ...(ctx.replyToId ? { replyToId: ctx.replyToId } : {}),
      });
      await rememberOutboundThread({
        account,
        target: ctx.to,
        text: ctx.text || `[Outbound Gmail attachment: ${attachment.filename}]`,
        threadId: result.threadId,
      });
      const replyToId = ctx.replyToId ?? undefined;
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: GMAIL_CHANNEL_ID, messageId: result.messageId }],
          threadId: result.threadId,
          ...(replyToId ? { replyToId } : {}),
          kind: "media",
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
            recipientSessionExact: parsed.kind === "thread",
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
          await rememberOutboundThread({
            account,
            target: to,
            text,
            threadId: result.threadId,
          });
          return { messageId: result.messageId };
        },
        sendMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
          accountId,
          replyToId,
        }) => {
          if (!mediaUrl) {
            throw new Error("Gmail attachment send requires a media URL");
          }
          const account = resolveGmailAccount({
            cfg: cfg as GmailCoreConfig,
            ...(accountId !== undefined ? { accountId } : {}),
          });
          const attachment = await loadGmailOutboundAttachment({
            mediaUrl,
            ...(mediaAccess ? { mediaAccess } : {}),
            ...(mediaLocalRoots ? { mediaLocalRoots } : {}),
            ...(mediaReadFile ? { mediaReadFile } : {}),
          });
          const result = await sendGmailText({
            account,
            client: createGmailClient(account),
            target: to,
            text,
            attachments: [attachment],
            ...(replyToId ? { replyToId } : {}),
          });
          await rememberOutboundThread({
            account,
            target: to,
            text: text || `[Outbound Gmail attachment: ${attachment.filename}]`,
            threadId: result.threadId,
          });
          return { messageId: result.messageId };
        },
      },
    },
  });
