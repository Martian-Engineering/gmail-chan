import { describe, expect, it, vi } from "vitest";
import { GmailClient, type GmailApi } from "./gmail-client.js";

function createApi(overrides: Partial<GmailApi> = {}): GmailApi {
  return {
    listMessages: vi.fn(async () => ({ messages: [] })),
    getMessage: vi.fn(async () => ({ id: "message-1", threadId: "thread-1" })),
    getThread: vi.fn(async () => ({ id: "thread-1", messages: [] })),
    markMessageRead: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ id: "sent-1", threadId: "thread-1" })),
    ...overrides,
  };
}

describe("GmailClient", () => {
  it("lists only validated Gmail message identifiers", async () => {
    const client = new GmailClient(
      createApi({
        listMessages: vi.fn(async () => ({
          messages: [
            { id: "message-1", threadId: "thread-1" },
            { id: "message-2", threadId: "thread-2" },
          ],
        })),
      }),
    );

    await expect(client.listUnreadMessageIds()).resolves.toEqual([
      "message-1",
      "message-2",
    ]);
  });

  it("rejects malformed message list responses", async () => {
    const client = new GmailClient(
      createApi({
        listMessages: vi.fn(async () => ({
          messages: [{ threadId: "thread-1" }],
        })),
      }),
    );

    await expect(client.listUnreadMessageIds()).rejects.toThrow(
      "Gmail list response",
    );
  });

  it("marks one successfully handled message read", async () => {
    const api = createApi();
    const client = new GmailClient(api);

    await client.markMessageRead("message-1");

    expect(api.markMessageRead).toHaveBeenCalledWith("message-1");
  });

  it("returns canonical IDs from a sent message", async () => {
    const api = createApi();
    const client = new GmailClient(api);

    await expect(client.sendRawMessage("encoded", "thread-1")).resolves.toEqual(
      {
        messageId: "sent-1",
        threadId: "thread-1",
      },
    );
    expect(api.sendMessage).toHaveBeenCalledWith({
      raw: "encoded",
      threadId: "thread-1",
    });
  });
});
