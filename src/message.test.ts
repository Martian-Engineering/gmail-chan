import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { buildRawEmail, parseGmailMessage } from "./message.js";

function encodeBody(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

describe("parseGmailMessage", () => {
  it("extracts bounded plain text and normalized headers", () => {
    const message = parseGmailMessage({
      id: "message-1",
      threadId: "thread-1",
      internalDate: "1720000000000",
      payload: {
        mimeType: "multipart/alternative",
        headers: [
          { name: "From", value: "Person <Person@Example.com>" },
          { name: "Subject", value: "Question" },
          { name: "Message-ID", value: "<message-1@example.com>" },
          { name: "References", value: "<earlier@example.com>" },
        ],
        parts: [
          {
            mimeType: "text/html",
            body: { data: encodeBody("<p>HTML body</p>") },
          },
          { mimeType: "text/plain", body: { data: encodeBody("Plain body") } },
        ],
      },
    });

    expect(message).toMatchObject({
      id: "message-1",
      threadId: "thread-1",
      senderEmail: "person@example.com",
      senderName: "Person",
      subject: "Question",
      messageIdHeader: "<message-1@example.com>",
      references: "<earlier@example.com>",
      text: "Plain body",
      timestampMs: 1720000000000,
    });
  });

  it("strips executable and markup content from HTML fallback", () => {
    const message = parseGmailMessage({
      id: "message-2",
      threadId: "thread-2",
      payload: {
        headers: [{ name: "From", value: "person@example.com" }],
        mimeType: "text/html",
        body: {
          data: encodeBody(
            "<style>bad</style><p>Hello &amp; welcome</p><script>bad()</script>",
          ),
        },
      },
    });

    expect(message.text).toBe("Hello & welcome");
  });

  it("rejects decoded bodies above the configured boundary", () => {
    expect(() =>
      parseGmailMessage(
        {
          id: "message-3",
          threadId: "thread-3",
          payload: {
            headers: [{ name: "From", value: "person@example.com" }],
            mimeType: "text/plain",
            body: { data: encodeBody("x".repeat(20)) },
          },
        },
        10,
      ),
    ).toThrow("body exceeds");
  });
});

describe("buildRawEmail", () => {
  it("builds a base64url RFC message with Gmail thread reply headers", () => {
    const raw = buildRawEmail({
      from: "agent@example.com",
      to: "person@example.com",
      subject: "Re: Question",
      text: "Answer",
      inReplyTo: "<message-1@example.com>",
      references: "<earlier@example.com> <message-1@example.com>",
    });
    const decoded = Buffer.from(raw, "base64url").toString("utf8");

    expect(decoded).toContain("From: agent@example.com\r\n");
    expect(decoded).toContain("To: person@example.com\r\n");
    expect(decoded).toContain("In-Reply-To: <message-1@example.com>\r\n");
    expect(decoded).toContain(
      "References: <earlier@example.com> <message-1@example.com>\r\n",
    );
    expect(decoded.endsWith("\r\n\r\nAnswer")).toBe(true);
  });

  it("rejects newline injection in headers", () => {
    expect(() =>
      buildRawEmail({
        from: "agent@example.com",
        to: "person@example.com\r\nBcc: attacker@example.com",
        subject: "Question",
        text: "Body",
      }),
    ).toThrow("header");
  });
});
