import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { normalizeEmailAddress } from "./target.js";

export const DEFAULT_MAX_MESSAGE_BODY_BYTES = 128 * 1024;
export const MAX_GMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_GMAIL_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_GMAIL_ATTACHMENTS = 10;
const MAX_HEADER_LENGTH = 32 * 1024;
const MAX_PARTS = 100;
const MAX_PART_DEPTH = 10;

/** Checks base64url length before allocating a decoded Gmail data buffer. */
export function isGmailDataWithinDecodedLimit(
  data: string,
  maxBytes: number,
): boolean {
  return data.length <= Math.ceil((maxBytes * 4) / 3) + 4;
}

const GmailHeaderSchema = z.object({
  name: z.string().max(256),
  value: z.string().max(MAX_HEADER_LENGTH),
});

const GmailBodySchema = z.object({
  data: z.string().optional(),
  attachmentId: z.string().max(1024).optional(),
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
    mimeType: z.string().max(255).optional().nullable(),
    filename: z.string().max(512).optional().nullable(),
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
  replyToEmails: string[];
  toEmails: string[];
  ccEmails: string[];
  timestampMs?: number;
};

export type ParsedGmailMessage = {
  id: string;
  threadId: string;
  senderEmail: string;
  senderName?: string;
  replyToEmails: string[];
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  messageIdHeader?: string;
  references?: string;
  text: string;
  attachments: GmailAttachmentDescriptor[];
  skippedAttachmentCount: number;
  timestampMs?: number;
};

export type GmailAttachmentDescriptor = {
  filename: string;
  mimeType: string;
  size?: number;
  attachmentId?: string;
  data?: string;
};

export type GmailReplyRecipients = { to: string[]; cc: string[] };

/** Resolves reply-all recipients while excluding the configured mailbox. */
export function resolveGmailReplyRecipients(
  message: Pick<
    GmailMessageEnvelope,
    "senderEmail" | "replyToEmails" | "toEmails" | "ccEmails"
  >,
  accountEmail: string,
): GmailReplyRecipients {
  const self = normalizeEmailAddress(accountEmail);
  const primary =
    message.replyToEmails.length > 0
      ? message.replyToEmails
      : [message.senderEmail];
  const to = [...new Set(primary)].filter((email) => email !== self);
  const toSet = new Set(to);
  const cc = [...new Set([...message.toEmails, ...message.ccEmails])].filter(
    (email) => email !== self && !toSet.has(email),
  );
  return { to, cc };
}

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

/** Collects a bounded set of filename-bearing MIME attachment parts. */
function findAttachmentCandidates(part: GmailMessagePart): {
  attachments: GmailAttachmentDescriptor[];
  skippedCount: number;
} {
  const attachments: GmailAttachmentDescriptor[] = [];
  let skippedCount = 0;
  let visited = 0;
  function visit(current: GmailMessagePart, depth: number): void {
    visited += 1;
    if (visited > MAX_PARTS || depth > MAX_PART_DEPTH) {
      throw new Error("Gmail MIME structure exceeds supported limits");
    }
    const filename = current.filename?.trim();
    if (filename) {
      if (
        current.body &&
        (current.body.attachmentId || current.body.data) &&
        attachments.length < MAX_GMAIL_ATTACHMENTS
      ) {
        attachments.push({
          filename,
          mimeType: current.mimeType?.trim() || "application/octet-stream",
          ...(current.body.size !== undefined
            ? { size: current.body.size }
            : {}),
          ...(current.body.attachmentId
            ? { attachmentId: current.body.attachmentId }
            : {}),
          ...(current.body.data ? { data: current.body.data } : {}),
        });
      } else {
        skippedCount += 1;
      }
    }
    for (const child of current.parts ?? []) {
      visit(child, depth + 1);
    }
  }
  visit(part, 0);
  return { attachments, skippedCount };
}

function decodeBody(data: string, maxBytes: number): string {
  if (!isGmailDataWithinDecodedLimit(data, maxBytes)) {
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

function getHeaders(part: GmailMessagePart, name: string): string[] {
  return (part.headers ?? [])
    .filter((header) => header.name.toLowerCase() === name.toLowerCase())
    .map((header) => header.value);
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

/** Splits one RFC-style address list without splitting quoted display names. */
function splitAddressList(value: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  let angleDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
    } else if (char === "\\" && quoted) {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === "<") {
      angleDepth += 1;
    } else if (!quoted && char === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (!quoted && angleDepth === 0 && char === ",") {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

/** Parses and deduplicates every address from repeated message headers. */
function parseAddressHeaders(part: GmailMessagePart, name: string): string[] {
  const addresses: string[] = [];
  for (const header of getHeaders(part, name)) {
    for (const entry of splitAddressList(header)) {
      const email = parseSender(entry).email;
      if (!addresses.includes(email)) {
        addresses.push(email);
      }
    }
  }
  return addresses;
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
    replyToEmails: parseAddressHeaders(message.payload, "Reply-To"),
    toEmails: parseAddressHeaders(message.payload, "To"),
    ccEmails: parseAddressHeaders(message.payload, "Cc"),
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
  const attachmentCandidates = findAttachmentCandidates(message.payload);
  const attachments = attachmentCandidates.attachments;
  const bodyData = bodies.plain ?? bodies.html;
  if (!bodyData && attachments.length === 0) {
    throw new Error("Gmail message has no supported text body");
  }
  const decoded = bodyData ? decodeBody(bodyData, maxBodyBytes) : "";
  const envelope = parseGmailMessageEnvelope(message);
  const messageIdHeader = getHeader(message.payload, "Message-ID");
  const references = getHeader(message.payload, "References");
  return {
    id: message.id,
    threadId: message.threadId,
    senderEmail: envelope.senderEmail,
    ...(envelope.senderName ? { senderName: envelope.senderName } : {}),
    replyToEmails: envelope.replyToEmails,
    toEmails: envelope.toEmails,
    ccEmails: envelope.ccEmails,
    subject: getHeader(message.payload, "Subject")?.trim() ?? "",
    ...(messageIdHeader ? { messageIdHeader } : {}),
    ...(references ? { references } : {}),
    text: bodies.plain ? decoded.trim() : htmlToText(decoded),
    attachments,
    skippedAttachmentCount: attachmentCandidates.skippedCount,
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
  to: string | string[];
  cc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  attachments?: RawEmailAttachment[];
};

export type RawEmailAttachment = {
  filename: string;
  contentType?: string;
  data: Buffer;
};

function normalizeRecipients(
  name: "To" | "Cc",
  value: string | string[],
): string[] {
  const values = Array.isArray(value) ? value : [value];
  const recipients = values.map((entry) =>
    normalizeEmailAddress(requireSafeHeader(name, entry)),
  );
  if (recipients.some((entry) => !entry)) {
    throw new Error(`Invalid ${name} email header`);
  }
  return [...new Set(recipients as string[])];
}

function sanitizeAttachmentFilename(value: string): string {
  const leaf = value.trim().split(/[\\/]/u).at(-1) ?? "";
  const sanitized = leaf.replace(/[^A-Za-z0-9._ -]/gu, "_").slice(0, 255);
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error("Invalid attachment filename");
  }
  return sanitized;
}

function normalizeAttachmentContentType(value?: string): string {
  const contentType = value?.trim() || "application/octet-stream";
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/u.test(contentType)) {
    throw new Error("Invalid attachment content type");
  }
  return contentType;
}

function wrapBase64(buffer: Buffer): string {
  return (
    buffer
      .toString("base64")
      .match(/.{1,76}/gu)
      ?.join("\r\n") ?? ""
  );
}

/** Builds the base64url RFC 2822 payload required by Gmail messages.send. */
export function buildRawEmail(input: RawEmailInput): string {
  const from = normalizeEmailAddress(requireSafeHeader("From", input.from));
  const to = normalizeRecipients("To", input.to);
  const cc = normalizeRecipients("Cc", input.cc ?? []);
  if (!from || to.length === 0) {
    throw new Error("Invalid From or To email header");
  }
  if (Buffer.byteLength(input.text, "utf8") > DEFAULT_MAX_MESSAGE_BODY_BYTES) {
    throw new Error(
      `Outbound email body exceeds ${DEFAULT_MAX_MESSAGE_BODY_BYTES} bytes`,
    );
  }
  const attachments = input.attachments ?? [];
  if (
    attachments.length > MAX_GMAIL_ATTACHMENTS ||
    attachments.some(
      (attachment) => attachment.data.byteLength > MAX_GMAIL_ATTACHMENT_BYTES,
    ) ||
    attachments.reduce(
      (total, attachment) => total + attachment.data.byteLength,
      0,
    ) > MAX_GMAIL_TOTAL_ATTACHMENT_BYTES
  ) {
    throw new Error("Outbound Gmail attachments exceed supported limits");
  }

  const headers = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (cc.length > 0) {
    headers.splice(2, 0, `Cc: ${cc.join(", ")}`);
  }
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
  if (attachments.length === 0) {
    headers.push(
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
    );
  }
  const body = (() => {
    if (attachments.length === 0) {
      return normalizeCrLf(input.text);
    }
    const boundary = `gmail-chan-${randomBytes(12).toString("hex")}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      normalizeCrLf(input.text),
    ];
    for (const attachment of attachments) {
      const filename = sanitizeAttachmentFilename(attachment.filename);
      parts.push(
        `--${boundary}`,
        `Content-Type: ${normalizeAttachmentContentType(attachment.contentType)}`,
        `Content-Disposition: attachment; filename="${filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(attachment.data),
      );
    }
    parts.push(`--${boundary}--`);
    return parts.join("\r\n");
  })();
  const raw = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}
