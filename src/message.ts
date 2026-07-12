import { Buffer } from "node:buffer";
import { z } from "zod";
import { normalizeEmailAddress } from "./target.js";

export const DEFAULT_MAX_MESSAGE_BODY_BYTES = 128 * 1024;
const MAX_HEADER_LENGTH = 32 * 1024;
const MAX_PARTS = 100;
const MAX_PART_DEPTH = 10;

const GmailHeaderSchema = z.object({
  name: z.string().max(256),
  value: z.string().max(MAX_HEADER_LENGTH),
});

const GmailBodySchema = z.object({
  data: z.string().optional(),
  attachmentId: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});

export type GmailMessagePart = {
  mimeType?: string | null | undefined;
  filename?: string | null | undefined;
  headers?: Array<z.infer<typeof GmailHeaderSchema>> | null | undefined;
  body?: z.infer<typeof GmailBodySchema> | null | undefined;
  parts?: GmailMessagePart[] | null | undefined;
};

const GmailMessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional().nullable(),
    filename: z.string().optional().nullable(),
    headers: z.array(GmailHeaderSchema).optional().nullable(),
    body: GmailBodySchema.optional().nullable(),
    parts: z.array(GmailMessagePartSchema).optional().nullable(),
  }),
);

export const GmailApiMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  labelIds: z.array(z.string()).optional().nullable(),
  internalDate: z.string().regex(/^\d+$/u).optional().nullable(),
  payload: GmailMessagePartSchema.optional().nullable(),
});

export type GmailApiMessage = z.infer<typeof GmailApiMessageSchema>;

const GmailMessageEnvelopeSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  internalDate: z.string().regex(/^\d+$/u).optional().nullable(),
  payload: z.object({
    headers: z.array(GmailHeaderSchema).optional().nullable(),
  }),
});

export type GmailMessageEnvelope = {
  id: string;
  threadId: string;
  senderEmail: string;
  senderName?: string;
  senderDomainAuthenticated: boolean;
  timestampMs?: number;
};

export type ParsedGmailMessage = {
  id: string;
  threadId: string;
  senderEmail: string;
  senderName?: string;
  subject: string;
  messageIdHeader?: string;
  references?: string;
  text: string;
  timestampMs?: number;
};

type BodyCandidates = { plain?: string; html?: string };

function findBodyCandidates(part: GmailMessagePart): BodyCandidates {
  const candidates: BodyCandidates = {};
  let visited = 0;

  function visit(current: GmailMessagePart, depth: number): void {
    visited += 1;
    if (visited > MAX_PARTS || depth > MAX_PART_DEPTH) {
      throw new Error("Gmail MIME structure exceeds supported limits");
    }
    if (
      current.body?.data &&
      current.mimeType === "text/plain" &&
      !candidates.plain
    ) {
      candidates.plain = current.body.data;
    }
    if (
      current.body?.data &&
      current.mimeType === "text/html" &&
      !candidates.html
    ) {
      candidates.html = current.body.data;
    }
    for (const child of current.parts ?? []) {
      visit(child, depth + 1);
    }
  }

  visit(part, 0);
  return candidates;
}

function decodeBody(data: string, maxBytes: number): string {
  if (data.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    throw new Error(`Gmail message body exceeds ${maxBytes} bytes`);
  }
  const decoded = Buffer.from(data, "base64url");
  if (decoded.byteLength > maxBytes) {
    throw new Error(`Gmail message body exceeds ${maxBytes} bytes`);
  }
  return decoded.toString("utf8");
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ")
    .replace(/<!--[^]*?-->/gu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/p\s*>/giu, "\n")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;/giu, "'")
    .replace(/[ \t]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .trim();
}

function getHeader(part: GmailMessagePart, name: string): string | undefined {
  return part.headers?.find(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  )?.value;
}

function hasAuthenticatedSenderDomain(
  senderEmail: string,
  authenticationResults: string | undefined,
): boolean {
  const senderDomain = senderEmail.split("@")[1]?.toLowerCase();
  if (!senderDomain) {
    return false;
  }
  if (!authenticationResults) {
    return false;
  }
  // Gmail prepends its boundary result. Never accept a later, sender-supplied
  // Authentication-Results field that could claim Google's authserv-id.
  const normalized = authenticationResults.replace(/\s+/gu, " ").trim();
  if (!/^mx\.google\.com\s*;/iu.test(normalized)) {
    return false;
  }
  return normalized.split(";").some((result) => {
    if (!/\bdmarc=pass\b/iu.test(result)) {
      return false;
    }
    const authenticatedDomain = /\bheader\.from=([^\s;]+)/iu
      .exec(result)?.[1]
      ?.toLowerCase()
      .replace(/\.$/u, "");
    return authenticatedDomain === senderDomain;
  });
}

function parseSender(value: string | undefined): {
  email: string;
  name?: string;
} {
  if (!value) {
    throw new Error("Gmail message is missing a From header");
  }
  const bracketed = /^(.*?)<([^<>]+)>$/u.exec(value.trim());
  const email = normalizeEmailAddress(bracketed?.[2] ?? value);
  if (!email) {
    throw new Error("Gmail message has an invalid From header");
  }
  const name = bracketed?.[1]?.trim().replace(/^"|"$/gu, "");
  return { email, ...(name ? { name } : {}) };
}

/** Reads routing and policy metadata without parsing the MIME body. */
export function parseGmailMessageEnvelope(
  input: unknown,
): GmailMessageEnvelope {
  const message = GmailMessageEnvelopeSchema.parse(input);
  const sender = parseSender(getHeader(message.payload, "From"));
  const timestampMs = message.internalDate
    ? Number(message.internalDate)
    : undefined;
  return {
    id: message.id,
    threadId: message.threadId,
    senderEmail: sender.email,
    ...(sender.name ? { senderName: sender.name } : {}),
    senderDomainAuthenticated: hasAuthenticatedSenderDomain(
      sender.email,
      getHeader(message.payload, "Authentication-Results"),
    ),
    ...(timestampMs !== undefined ? { timestampMs } : {}),
  };
}

/** Validates and converts one Gmail API message into bounded text for OpenClaw. */
export function parseGmailMessage(
  input: unknown,
  maxBodyBytes = DEFAULT_MAX_MESSAGE_BODY_BYTES,
): ParsedGmailMessage {
  const message = GmailApiMessageSchema.parse(input);
  if (!message.payload) {
    throw new Error("Gmail message has no MIME payload");
  }

  // Prefer the sender's plain-text alternative. HTML is treated only as text.
  const bodies = findBodyCandidates(message.payload);
  const bodyData = bodies.plain ?? bodies.html;
  if (!bodyData) {
    throw new Error("Gmail message has no supported text body");
  }
  const decoded = decodeBody(bodyData, maxBodyBytes);
  const envelope = parseGmailMessageEnvelope(message);
  const messageIdHeader = getHeader(message.payload, "Message-ID");
  const references = getHeader(message.payload, "References");
  return {
    id: message.id,
    threadId: message.threadId,
    senderEmail: envelope.senderEmail,
    ...(envelope.senderName ? { senderName: envelope.senderName } : {}),
    subject: getHeader(message.payload, "Subject")?.trim() ?? "",
    ...(messageIdHeader ? { messageIdHeader } : {}),
    ...(references ? { references } : {}),
    text: bodies.plain ? decoded.trim() : htmlToText(decoded),
    ...(envelope.timestampMs !== undefined
      ? { timestampMs: envelope.timestampMs }
      : {}),
  };
}

function requireSafeHeader(
  name: string,
  value: string,
  maxLength = 998,
): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\r\n]/u.test(trimmed)) {
    throw new Error(`Invalid ${name} email header`);
  }
  return trimmed;
}

function encodeSubject(subject: string): string {
  const safe = requireSafeHeader("Subject", subject);
  return /^[\x20-\x7e]+$/u.test(safe)
    ? safe
    : `=?UTF-8?B?${Buffer.from(safe, "utf8").toString("base64")}?=`;
}

function normalizeCrLf(value: string): string {
  return value.replace(/\r?\n/gu, "\n").replace(/\n/gu, "\r\n");
}

export type RawEmailInput = {
  from: string;
  to: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
};

/** Builds the base64url RFC 2822 payload required by Gmail messages.send. */
export function buildRawEmail(input: RawEmailInput): string {
  const from = normalizeEmailAddress(requireSafeHeader("From", input.from));
  const to = normalizeEmailAddress(requireSafeHeader("To", input.to));
  if (!from || !to) {
    throw new Error("Invalid From or To email header");
  }
  if (Buffer.byteLength(input.text, "utf8") > DEFAULT_MAX_MESSAGE_BODY_BYTES) {
    throw new Error(
      `Outbound email body exceeds ${DEFAULT_MAX_MESSAGE_BODY_BYTES} bytes`,
    );
  }

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  if (input.inReplyTo) {
    headers.push(
      `In-Reply-To: ${requireSafeHeader("In-Reply-To", input.inReplyTo)}`,
    );
  }
  if (input.references) {
    headers.push(
      `References: ${requireSafeHeader("References", input.references, MAX_HEADER_LENGTH)}`,
    );
  }
  const raw = `${headers.join("\r\n")}\r\n\r\n${normalizeCrLf(input.text)}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}
