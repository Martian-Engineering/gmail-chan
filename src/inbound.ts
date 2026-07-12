import { Buffer } from "node:buffer";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { GmailCoreConfig, ResolvedGmailAccount } from "./accounts.js";
import type { GmailClient } from "./gmail-client.js";
import type { GmailApiMessage, ParsedGmailMessage } from "./message.js";
import {
  MAX_GMAIL_ATTACHMENT_BYTES,
  MAX_GMAIL_TOTAL_ATTACHMENT_BYTES,
  parseGmailMessage,
  parseGmailMessageEnvelope,
  resolveGmailReplyRecipients,
} from "./message.js";
import { isAddressAllowed } from "./policy.js";
import { buildGmailThreadTarget } from "./target.js";
import {
  recordOutboundThreadContext,
  takeOutboundThreadContext,
} from "./thread-context.js";

export type GmailInboundDisposition = "dispatched" | "ignored";

async function materializeAttachments(params: {
  client: GmailClient | undefined;
  message: ParsedGmailMessage;
  runtime: PluginRuntime;
}) {
  const media: Array<{
    path: string;
    contentType?: string;
    kind: "image" | "video" | "audio" | "document";
    messageId: string;
  }> = [];
  let totalBytes = 0;
  for (const attachment of params.message.attachments) {
    if (
      (attachment.size ?? 0) > MAX_GMAIL_ATTACHMENT_BYTES ||
      totalBytes + (attachment.size ?? 0) > MAX_GMAIL_TOTAL_ATTACHMENT_BYTES
    ) {
      continue;
    }
    const data = attachment.data
      ? Buffer.from(attachment.data, "base64url")
      : attachment.attachmentId && params.client
        ? await params.client.getAttachmentData(
            params.message.id,
            attachment.attachmentId,
            Math.min(
              MAX_GMAIL_ATTACHMENT_BYTES,
              MAX_GMAIL_TOTAL_ATTACHMENT_BYTES - totalBytes,
            ),
          )
        : undefined;
    if (
      !data ||
      data.byteLength > MAX_GMAIL_ATTACHMENT_BYTES ||
      totalBytes + data.byteLength > MAX_GMAIL_TOTAL_ATTACHMENT_BYTES
    ) {
      continue;
    }
    totalBytes += data.byteLength;
    const saved = await params.runtime.channel.media.saveMediaBuffer(
      data,
      attachment.mimeType,
      "inbound",
      MAX_GMAIL_ATTACHMENT_BYTES,
      attachment.filename,
    );
    const contentType = saved.contentType ?? attachment.mimeType;
    const kind = contentType.startsWith("image/")
      ? "image"
      : contentType.startsWith("video/")
        ? "video"
        : contentType.startsWith("audio/")
          ? "audio"
          : "document";
    media.push({
      path: saved.path,
      ...(contentType ? { contentType } : {}),
      kind,
      messageId: params.message.id,
    });
  }
  return media;
}

/** Admits and dispatches one validated Gmail message through OpenClaw. */
export async function handleGmailInbound(params: {
  account: ResolvedGmailAccount;
  cfg: GmailCoreConfig;
  message: GmailApiMessage;
  runtime: PluginRuntime;
  client?: GmailClient;
}): Promise<GmailInboundDisposition> {
  // Apply sender policy before decoding untrusted MIME content or invoking an
  // agent. A sender must be eligible for both admission and the reply path.
  const envelope = parseGmailMessageEnvelope(params.message);
  const replyRecipients = resolveGmailReplyRecipients(
    envelope,
    params.account.email,
  );
  const allReplyRecipients = [...replyRecipients.to, ...replyRecipients.cc];
  if (
    envelope.senderEmail === params.account.email ||
    !isAddressAllowed(envelope.senderEmail, params.account.allowFrom) ||
    allReplyRecipients.length === 0 ||
    allReplyRecipients.some(
      (email) => !isAddressAllowed(email, params.account.allowTo),
    ) ||
    !envelope.senderDomainAuthenticated
  ) {
    return "ignored";
  }
  const message = parseGmailMessage(params.message);
  const media = await materializeAttachments({
    client: params.client,
    message,
    runtime: params.runtime,
  });

  // A Gmail thread is a channel peer so DM scope cannot merge distinct threads.
  const target = buildGmailThreadTarget(message.threadId);
  const pendingOutbound = await takeOutboundThreadContext({
    runtime: params.runtime,
    accountId: params.account.accountId,
    threadId: message.threadId,
  });
  try {
    const cfg = params.cfg as OpenClawConfig;
    const route = params.runtime.channel.routing.resolveAgentRoute({
      cfg,
      channel: "gmail",
      accountId: params.account.accountId,
      peer: { kind: "channel", id: target },
    });
    const storePath = params.runtime.channel.session.resolveStorePath(
      cfg.session?.store,
      {
        agentId: route.agentId,
      },
    );
    const ctxPayload = params.runtime.channel.inbound.buildContext({
      channel: "gmail",
      accountId: params.account.accountId,
      provider: "gmail",
      surface: "gmail",
      messageId: message.id,
      ...(message.timestampMs !== undefined
        ? { timestamp: message.timestampMs }
        : {}),
      from: `gmail:${message.senderEmail}`,
      sender: {
        id: message.senderEmail,
        ...(message.senderName ? { name: message.senderName } : {}),
        displayLabel: message.senderName ?? message.senderEmail,
      },
      conversation: {
        kind: "channel",
        id: target,
        label: message.subject || `Gmail thread ${message.threadId}`,
        threadId: message.threadId,
        nativeChannelId: message.threadId,
        routePeer: { kind: "channel", id: target },
      },
      route: {
        agentId: route.agentId,
        accountId: route.accountId ?? params.account.accountId,
        routeSessionKey: route.sessionKey,
      },
      reply: {
        to: target,
        originatingTo: target,
        nativeChannelId: message.threadId,
        replyTarget: target,
        deliveryTarget: target,
        replyToId: message.id,
        messageThreadId: message.threadId,
        sourceReplyDeliveryMode: "thread",
      },
      message: {
        inboundEventKind: "user_request",
        body: message.text,
        rawBody: message.text,
        bodyForAgent: message.text,
        commandBody: message.text,
        senderLabel: message.senderName ?? message.senderEmail,
      },
      ...(media.length > 0 ? { media } : {}),
      ...(pendingOutbound
        ? {
            supplemental: {
              thread: {
                id: message.threadId,
                label: "Earlier outbound Gmail message",
                starterBody: pendingOutbound.text,
                senderAllowed: true,
              },
            },
          }
        : {}),
    });

    await params.runtime.channel.inbound.dispatchReply({
      cfg,
      channel: "gmail",
      accountId: params.account.accountId,
      agentId: route.agentId,
      routeSessionKey: route.sessionKey,
      storePath,
      ctxPayload,
      recordInboundSession: params.runtime.channel.session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher:
        params.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        durable: {
          to: target,
          threadId: message.threadId,
          replyToId: message.id,
        },
        deliver: async () => {
          throw new Error(
            "Gmail durable message adapter did not handle the reply",
          );
        },
      },
      replyPipeline: {},
      record: {
        onRecordError(error) {
          throw error instanceof Error ? error : new Error(String(error));
        },
      },
    });
  } catch (error) {
    if (pendingOutbound) {
      await recordOutboundThreadContext({
        runtime: params.runtime,
        accountId: pendingOutbound.accountId,
        threadId: pendingOutbound.threadId,
        text: pendingOutbound.text,
        now: pendingOutbound.createdAt,
      });
    }
    throw error;
  }
  return "dispatched";
}
