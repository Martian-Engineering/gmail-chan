import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { GmailCoreConfig, ResolvedGmailAccount } from "./accounts.js";
import { handleGmailInbound } from "./inbound.js";

const account: ResolvedGmailAccount = {
  accountId: "work",
  enabled: true,
  configured: true,
  email: "agent@example.com",
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
  allowFrom: ["person@example.com"],
  allowTo: ["person@example.com"],
  pollIntervalSeconds: 30,
};

const cfg = {
  channels: { gmail: { accounts: {} } },
} as unknown as GmailCoreConfig;

function gmailMessage(id: string, threadId: string, from: string) {
  return {
    id,
    threadId,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: "Question" },
      ],
      body: { data: Buffer.from("Question body").toString("base64url") },
    },
  };
}

function createRuntime() {
  const dispatchReply = vi.fn(async (params: unknown) => {
    void params;
    return { kind: "dispatched" };
  });
  const runtime = {
    channel: {
      routing: {
        resolveAgentRoute: ({ peer }: { peer: { id: string } }) => ({
          accountId: "work",
          agentId: "main",
          sessionKey: `agent:main:gmail:channel:${peer.id}`,
        }),
      },
      session: {
        resolveStorePath: () => "/tmp/gmail-session-store.json",
        recordInboundSession: vi.fn(),
      },
      inbound: {
        buildContext: (facts: {
          route: { routeSessionKey: string };
          message: { rawBody: string };
        }) => ({
          Body: facts.message.rawBody,
          BodyForAgent: facts.message.rawBody,
          BodyForCommands: facts.message.rawBody,
          ChatType: "channel",
          CommandAuthorized: false,
          CommandBody: facts.message.rawBody,
          From: "gmail",
          RawBody: facts.message.rawBody,
          SessionKey: facts.route.routeSessionKey,
          To: "gmail",
          InboundEventKind: "message",
        }),
        dispatchReply,
      },
      reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
    },
  } as unknown as PluginRuntime;
  return { runtime, dispatchReply };
}

describe("handleGmailInbound", () => {
  it("routes every message in one Gmail thread to one session", async () => {
    const { runtime, dispatchReply } = createRuntime();

    await handleGmailInbound({
      account,
      cfg,
      message: gmailMessage("message-1", "thread-1", "person@example.com"),
      runtime,
    });
    await handleGmailInbound({
      account,
      cfg,
      message: gmailMessage("message-2", "thread-1", "person@example.com"),
      runtime,
    });
    await handleGmailInbound({
      account,
      cfg,
      message: gmailMessage("message-3", "thread-2", "person@example.com"),
      runtime,
    });

    const keys = dispatchReply.mock.calls.map(
      (call) => (call[0] as { routeSessionKey: string }).routeSessionKey,
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("does not dispatch self-authored or denied messages", async () => {
    const { runtime, dispatchReply } = createRuntime();

    await expect(
      handleGmailInbound({
        account,
        cfg,
        message: gmailMessage("message-1", "thread-1", "agent@example.com"),
        runtime,
      }),
    ).resolves.toBe("ignored");
    await expect(
      handleGmailInbound({
        account,
        cfg,
        message: gmailMessage("message-2", "thread-2", "outside@example.net"),
        runtime,
      }),
    ).resolves.toBe("ignored");
    expect(dispatchReply).not.toHaveBeenCalled();
  });
});
