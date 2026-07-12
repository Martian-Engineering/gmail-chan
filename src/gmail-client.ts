import { auth, gmail } from "@googleapis/gmail";
import { z } from "zod";
import { Buffer } from "node:buffer";
import type { ResolvedGmailAccount } from "./accounts.js";
import { GmailApiMessageSchema, type GmailApiMessage } from "./message.js";

const MessageListSchema = z.object({
  messages: z
    .array(z.object({ id: z.string().min(1), threadId: z.string().min(1) }))
    .optional()
    .default([]),
});

const GmailThreadSchema = z.object({
  id: z.string().min(1),
  messages: z.array(GmailApiMessageSchema).optional().default([]),
});

const SentMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
});

const AttachmentBodySchema = z.object({
  data: z.string(),
  size: z.number().int().nonnegative().optional(),
});

/** Error raised when Gmail attachment bytes exceed the caller's fixed budget. */
export class GmailAttachmentTooLargeError extends Error {
  public constructor(maxBytes: number) {
    super(`Gmail attachment exceeds ${maxBytes} bytes`);
    this.name = "GmailAttachmentTooLargeError";
  }
}

export type GmailApi = {
  listMessages: () => Promise<unknown>;
  getMessage: (messageId: string) => Promise<unknown>;
  getThread: (threadId: string) => Promise<unknown>;
  getAttachment: (messageId: string, attachmentId: string) => Promise<unknown>;
  markMessageRead: (messageId: string) => Promise<void>;
  sendMessage: (input: { raw: string; threadId?: string }) => Promise<unknown>;
};

export type GmailThread = z.infer<typeof GmailThreadSchema>;

/** Validated Gmail operations used by polling, inbound parsing, and outbound delivery. */
export class GmailClient {
  readonly #api: GmailApi;

  public constructor(api: GmailApi) {
    this.#api = api;
  }

  /** Lists unread inbox message IDs after validating the Gmail response. */
  public async listUnreadMessageIds(): Promise<string[]> {
    const result = MessageListSchema.safeParse(await this.#api.listMessages());
    if (!result.success) {
      throw new Error("Invalid Gmail list response", { cause: result.error });
    }
    return result.data.messages.map((message) => message.id);
  }

  /** Fetches and validates one full Gmail message. */
  public async getMessage(messageId: string): Promise<GmailApiMessage> {
    const result = GmailApiMessageSchema.safeParse(
      await this.#api.getMessage(messageId),
    );
    if (!result.success) {
      throw new Error("Invalid Gmail message response", {
        cause: result.error,
      });
    }
    return result.data;
  }

  /** Fetches and validates every message in one Gmail thread. */
  public async getThread(threadId: string): Promise<GmailThread> {
    const result = GmailThreadSchema.safeParse(
      await this.#api.getThread(threadId),
    );
    if (!result.success) {
      throw new Error("Invalid Gmail thread response", { cause: result.error });
    }
    return result.data;
  }

  /** Downloads one Gmail attachment and enforces its decoded byte limit. */
  public async getAttachmentData(
    messageId: string,
    attachmentId: string,
    maxBytes: number,
  ): Promise<Buffer> {
    const response = await this.#api.getAttachment(messageId, attachmentId);
    if (
      response &&
      typeof response === "object" &&
      "data" in response &&
      typeof response.data === "string" &&
      response.data.length > Math.ceil((maxBytes * 4) / 3) + 4
    ) {
      throw new GmailAttachmentTooLargeError(maxBytes);
    }
    const result = AttachmentBodySchema.safeParse(response);
    if (!result.success) {
      throw new Error("Invalid Gmail attachment response", {
        cause: result.error,
      });
    }
    if (result.data.size !== undefined && result.data.size > maxBytes) {
      throw new GmailAttachmentTooLargeError(maxBytes);
    }
    const buffer = Buffer.from(result.data.data, "base64url");
    if (buffer.byteLength > maxBytes) {
      throw new GmailAttachmentTooLargeError(maxBytes);
    }
    return buffer;
  }

  /** Removes the unread label after the channel has handled a message. */
  public async markMessageRead(messageId: string): Promise<void> {
    await this.#api.markMessageRead(messageId);
  }

  /** Sends one encoded message and returns Gmail's canonical message and thread IDs. */
  public async sendRawMessage(
    raw: string,
    threadId?: string,
  ): Promise<{ messageId: string; threadId: string }> {
    const input = { raw, ...(threadId ? { threadId } : {}) };
    const result = SentMessageSchema.safeParse(
      await this.#api.sendMessage(input),
    );
    if (!result.success) {
      throw new Error("Invalid Gmail send response", { cause: result.error });
    }
    return { messageId: result.data.id, threadId: result.data.threadId };
  }
}

/** Creates the HTTPS Gmail API adapter for one resolved OAuth account. */
export function createGoogleGmailApi(account: ResolvedGmailAccount): GmailApi {
  if (!account.configured) {
    throw new Error(
      `Gmail account "${account.accountId}" is not fully configured`,
    );
  }
  const oauth = new auth.OAuth2(account.clientId, account.clientSecret);
  oauth.setCredentials({ refresh_token: account.refreshToken });
  const service = gmail({ version: "v1", auth: oauth });
  return {
    async listMessages() {
      const response = await service.users.messages.list({
        userId: "me",
        q: "in:inbox is:unread",
        maxResults: 20,
      });
      return response.data;
    },
    async getMessage(messageId) {
      const response = await service.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });
      return response.data;
    },
    async getThread(threadId) {
      const response = await service.users.threads.get({
        userId: "me",
        id: threadId,
        format: "full",
      });
      return response.data;
    },
    async getAttachment(messageId, attachmentId) {
      const response = await service.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      });
      return response.data;
    },
    async markMessageRead(messageId) {
      await service.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });
    },
    async sendMessage(input) {
      const response = await service.users.messages.send({
        userId: "me",
        requestBody: {
          raw: input.raw,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      });
      return response.data;
    },
  };
}

/** Creates the validated Gmail client used by channel runtime code. */
export function createGmailClient(account: ResolvedGmailAccount): GmailClient {
  return new GmailClient(createGoogleGmailApi(account));
}
