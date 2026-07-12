import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { GmailCoreConfig, ResolvedGmailAccount } from "./accounts.js";
import type { GmailApiMessage } from "./message.js";
import { parseGmailMessage, parseGmailMessageEnvelope } from "./message.js";
import { isAddressAllowed } from "./policy.js";
import { buildGmailThreadTarget } from "./target.js";

export type GmailInboundDisposition = "dispatched" | "ignored";

/** Admits and dispatches one validated Gmail message through OpenClaw. */
export async function handleGmailInbound(params: {
  account: ResolvedGmailAccount;
  cfg: GmailCoreConfig;
  message: GmailApiMessage;
  runtime: PluginRuntime;
}): Promise<GmailInboundDisposition> {
  // Apply sender policy before decoding untrusted MIME content or invoking an
  // agent. A sender must be eligible for both admission and the reply path.
  const envelope = parseGmailMessageEnvelope(params.message);
  if (
    envelope.senderEmail === params.account.email ||
    !isAddressAllowed(envelope.senderEmail, params.account.allowFrom) ||
    !isAddressAllowed(envelope.senderEmail, params.account.allowTo)
  ) {
    return "ignored";
  }
  const message = parseGmailMessage(params.message);

  // A Gmail thread is a channel peer so DM scope cannot merge distinct threads.
  const target = buildGmailThreadTarget(message.threadId);
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
  return "dispatched";
}
