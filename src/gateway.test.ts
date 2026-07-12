import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import type { GmailCoreConfig, ResolvedGmailAccount } from "./accounts.js";
import { GmailClient, type GmailApi } from "./gmail-client.js";
import { pollGmailOnce } from "./gateway.js";

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

function message() {
  return {
    id: "message-1",
    threadId: "thread-1",
    payload: {
      mimeType: "text/plain",
      headers: [{ name: "From", value: "person@example.com" }],
      body: { data: Buffer.from("Question").toString("base64url") },
    },
  };
}

function createClient(): {
  client: GmailClient;
  markMessageRead: ReturnType<typeof vi.fn>;
} {
  const markMessageRead = vi.fn(async () => undefined);
  const api: GmailApi = {
    listMessages: vi.fn(async () => ({
      messages: [{ id: "message-1", threadId: "thread-1" }],
    })),
    getMessage: vi.fn(async () => message()),
    getThread: vi.fn(),
    markMessageRead,
    sendMessage: vi.fn(),
  };
  return { client: new GmailClient(api), markMessageRead };
}

describe("pollGmailOnce", () => {
  it("marks a source message read only after dispatch succeeds", async () => {
    const { client, markMessageRead } = createClient();
    const dispatch = vi.fn(async () => "dispatched" as const);

    await pollGmailOnce({
      account,
      cfg: {} as GmailCoreConfig,
      client,
      runtime: {} as PluginRuntime,
      dispatch,
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(markMessageRead).toHaveBeenCalledWith("message-1");
  });

  it("leaves a message unread when dispatch fails", async () => {
    const { client, markMessageRead } = createClient();
    const dispatch = vi.fn(async () => {
      throw new Error("dispatch failed");
    });

    await expect(
      pollGmailOnce({
        account,
        cfg: {} as GmailCoreConfig,
        client,
        runtime: {} as PluginRuntime,
        dispatch,
      }),
    ).rejects.toThrow("dispatch failed");
    expect(markMessageRead).not.toHaveBeenCalled();
  });
});
