import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedGmailAccount } from "./accounts.js";
import { GmailClient, type GmailApi } from "./gmail-client.js";
import { sendGmailText } from "./outbound.js";

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

function createClient(): {
  client: GmailClient;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn(async () => ({
    id: "sent-1",
    threadId: "thread-1",
  }));
  const api: GmailApi = {
    listMessages: vi.fn(async () => ({ messages: [] })),
    getMessage: vi.fn(),
    getThread: vi.fn(async () => ({
      id: "thread-1",
      messages: [
        {
          id: "message-1",
          threadId: "thread-1",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "From", value: "Person <person@example.com>" },
              { name: "Subject", value: "Question" },
              { name: "Message-ID", value: "<message-1@example.com>" },
            ],
            body: { data: Buffer.from("Question body").toString("base64url") },
          },
        },
      ],
    })),
    markMessageRead: vi.fn(),
    sendMessage,
  };
  return { client: new GmailClient(api), sendMessage };
}

describe("sendGmailText", () => {
  it("replies to the latest external sender in an existing thread", async () => {
    const { client, sendMessage } = createClient();

    await expect(
      sendGmailText({
        account,
        client,
        target: "thread:thread-1",
        text: "Answer",
      }),
    ).resolves.toEqual({ messageId: "sent-1", threadId: "thread-1" });

    const input = sendMessage.mock.calls[0]?.[0] as {
      raw: string;
      threadId: string;
    };
    const decoded = Buffer.from(input.raw, "base64url").toString("utf8");
    expect(input.threadId).toBe("thread-1");
    expect(decoded).toContain("To: person@example.com\r\n");
    expect(decoded).toContain("Subject: Re: Question\r\n");
    expect(decoded).toContain("In-Reply-To: <message-1@example.com>\r\n");
  });

  it("denies a new outbound thread outside allowTo", async () => {
    const { client } = createClient();

    await expect(
      sendGmailText({
        account,
        client,
        target: "mailto:outside@example.net",
        text: "Hello",
      }),
    ).rejects.toThrow("not allowed");
  });
});
