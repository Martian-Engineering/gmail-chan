import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import {
  resolveGmailAccount,
  type GmailCoreConfig,
  type ResolvedGmailAccount,
} from "./accounts.js";
import { createGmailClient, type GmailClient } from "./gmail-client.js";
import { handleGmailInbound, type GmailInboundDisposition } from "./inbound.js";

const activeMessages = new Set<string>();

type GmailInboundDispatch = typeof handleGmailInbound;

/** Polls and processes one bounded page of unread Gmail messages. */
export async function pollGmailOnce(params: {
  account: ResolvedGmailAccount;
  cfg: GmailCoreConfig;
  client: GmailClient;
  runtime: PluginRuntime;
  dispatch?: GmailInboundDispatch;
}): Promise<void> {
  const dispatch = params.dispatch ?? handleGmailInbound;
  for (const messageId of await params.client.listUnreadMessageIds()) {
    const key = `${params.account.accountId}:${messageId}`;
    if (activeMessages.has(key)) {
      continue;
    }
    activeMessages.add(key);
    try {
      const message = await params.client.getMessage(messageId);
      await dispatch({
        account: params.account,
        cfg: params.cfg,
        message,
        runtime: params.runtime,
        client: params.client,
      });
      await params.client.markMessageRead(messageId);
    } finally {
      activeMessages.delete(key);
    }
  }
}

function waitForNextPoll(
  abortSignal: AbortSignal,
  intervalMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, intervalMs);
    function finish() {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", finish);
      resolve();
    }
    abortSignal.addEventListener("abort", finish, { once: true });
  });
}

/** Runs one Gmail account until OpenClaw aborts the channel gateway lifecycle. */
export async function startGmailGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedGmailAccount>,
  runtime: PluginRuntime,
): Promise<void> {
  const account = resolveGmailAccount({
    cfg: ctx.cfg as GmailCoreConfig,
    accountId: ctx.accountId,
  });
  if (!account.configured) {
    throw new Error(
      `Gmail account "${account.accountId}" is not fully configured`,
    );
  }
  const client = createGmailClient(account);
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    configured: true,
  });
  try {
    while (!ctx.abortSignal.aborted) {
      await pollGmailOnce({
        account,
        cfg: ctx.cfg as GmailCoreConfig,
        client,
        runtime,
      });
      await waitForNextPoll(
        ctx.abortSignal,
        account.pollIntervalSeconds * 1_000,
      );
    }
  } finally {
    ctx.setStatus({ accountId: account.accountId, running: false });
  }
}

export type { GmailInboundDisposition };
