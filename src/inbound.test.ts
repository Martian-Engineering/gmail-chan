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
        { name: "To", value: "agent@example.com" },
        { name: "Subject", value: "Question" },
        {
          name: "Authentication-Results",
          value: "mx.google.com; dmarc=pass (p=NONE) header.from=example.com",
        },
      ],
      body: { data: Buffer.from("Question body").toString("base64url") },
    },
  };
}

function createRuntime(pendingText?: string) {
  const dispatchReply = vi.fn(async (params: unknown) => {
    void params;
    return { kind: "dispatched" };
  });
  const pendingContext = pendingText
    ? {
        accountId: "work",
        threadId: "thread-1",
        text: pendingText,
        createdAt: 1,
      }
    : undefined;
  const threadStore = {
    register: vi.fn(async () => undefined),
    registerIfAbsent: vi.fn(),
    lookup: vi.fn(async () => pendingContext),
    consume: vi.fn(async () => pendingContext),
    delete: vi.fn(async () => true),
    entries: vi.fn(async () => []),
    clear: vi.fn(),
  };
  const buildContext = vi.fn(
    (facts: {
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
  );
  const runtime = {
    state: { openKeyedStore: () => threadStore },
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
        buildContext,
        dispatchReply,
      },
      reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
    },
  } as unknown as PluginRuntime;
  return { runtime, dispatchReply, buildContext, threadStore };
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

  it("carries an outbound opener into the first canonical thread reply", async () => {
    const { runtime, buildContext, threadStore } = createRuntime(
      "Earlier outbound question",
    );

    await handleGmailInbound({
      account,
      cfg,
      message: gmailMessage("message-1", "thread-1", "person@example.com"),
      runtime,
    });

    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        supplemental: {
          thread: expect.objectContaining({
            id: "thread-1",
            starterBody: "Earlier outbound question",
          }),
        },
      }),
    );
    expect(threadStore.consume).toHaveBeenCalledWith("work:thread-1");
  });

  it("restores an outbound opener when dispatch fails", async () => {
    const { runtime, dispatchReply, threadStore } = createRuntime(
      "Earlier outbound question",
    );
    dispatchReply.mockRejectedValueOnce(new Error("dispatch failed"));

    await expect(
      handleGmailInbound({
        account,
        cfg,
        message: gmailMessage("message-1", "thread-1", "person@example.com"),
        runtime,
      }),
    ).rejects.toThrow("dispatch failed");
    expect(threadStore.register).toHaveBeenCalledWith(
      "work:thread-1",
      expect.objectContaining({ text: "Earlier outbound question" }),
    );
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

  it("does not dispatch when the sender cannot receive a reply", async () => {
    const { runtime, dispatchReply } = createRuntime();

    await expect(
      handleGmailInbound({
        account: { ...account, allowTo: [] },
        cfg,
        message: gmailMessage("message-1", "thread-1", "person@example.com"),
        runtime,
      }),
    ).resolves.toBe("ignored");
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("does not dispatch when any reply-all recipient is denied", async () => {
    const { runtime, dispatchReply } = createRuntime();
    const message = gmailMessage("message-1", "thread-1", "person@example.com");
    message.payload.headers.push({
      name: "Cc",
      value: "outside@example.net",
    });

    await expect(
      handleGmailInbound({ account, cfg, message, runtime }),
    ).resolves.toBe("ignored");
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("does not trust a later sender-supplied authentication result", async () => {
    const { runtime, dispatchReply } = createRuntime();
    const spoofed = gmailMessage("message-1", "thread-1", "person@example.com");
    spoofed.payload.headers.unshift({
      name: "Authentication-Results",
      value: "mx.google.com; dmarc=fail header.from=example.com",
    });

    await expect(
      handleGmailInbound({ account, cfg, message: spoofed, runtime }),
    ).resolves.toBe("ignored");
    expect(dispatchReply).not.toHaveBeenCalled();
  });

  it("classifies denied senders before parsing unsupported MIME bodies", async () => {
    const { runtime, dispatchReply } = createRuntime();
    const unsupported = {
      id: "message-1",
      threadId: "thread-1",
      payload: {
        mimeType: "application/pdf",
        headers: [{ name: "From", value: "outside@example.net" }],
      },
    };

    await expect(
      handleGmailInbound({ account, cfg, message: unsupported, runtime }),
    ).resolves.toBe("ignored");
    expect(dispatchReply).not.toHaveBeenCalled();
  });
});
