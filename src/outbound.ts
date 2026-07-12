import type { ResolvedGmailAccount } from "./accounts.js";
import type { GmailClient } from "./gmail-client.js";
import {
  buildRawEmail,
  parseGmailMessage,
  type ParsedGmailMessage,
} from "./message.js";
import { isAddressAllowed } from "./policy.js";
import { parseGmailTarget } from "./target.js";

function buildReplySubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) {
    return "Re: Gmail message";
  }
  return /^re:/iu.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

async function resolveReplySource(
  account: ResolvedGmailAccount,
  client: GmailClient,
  threadId: string,
  replyToId?: string,
): Promise<ParsedGmailMessage> {
  if (replyToId) {
    const source = parseGmailMessage(await client.getMessage(replyToId));
    if (source.threadId !== threadId || source.senderEmail === account.email) {
      throw new Error(
        `Gmail reply source "${replyToId}" does not belong to thread "${threadId}"`,
      );
    }
    return source;
  }
  const thread = await client.getThread(threadId);
  for (const message of [...thread.messages].reverse()) {
    try {
      const parsed = parseGmailMessage(message);
      if (parsed.senderEmail !== account.email) {
        return parsed;
      }
    } catch {
      // Attachment-only and unsupported MIME messages cannot supply reply metadata.
    }
  }
  throw new Error(
    `Gmail thread "${threadId}" has no external text message to reply to`,
  );
}

function buildReferences(source: ParsedGmailMessage): string | undefined {
  const references = [source.references, source.messageIdHeader]
    .filter(Boolean)
    .join(" ")
    .trim();
  return references || undefined;
}

/** Sends text to a new address or replies inside an existing Gmail thread. */
export async function sendGmailText(params: {
  account: ResolvedGmailAccount;
  client: GmailClient;
  target: string;
  text: string;
  replyToId?: string;
}): Promise<{ messageId: string; threadId: string }> {
  const target = parseGmailTarget(params.target);
  if (!target) {
    throw new Error(`Invalid Gmail target: ${params.target}`);
  }

  if (target.kind === "email") {
    if (!isAddressAllowed(target.email, params.account.allowTo)) {
      throw new Error(`Gmail recipient "${target.email}" is not allowed`);
    }
    const raw = buildRawEmail({
      from: params.account.email,
      to: target.email,
      subject: "OpenClaw message",
      text: params.text,
    });
    return await params.client.sendRawMessage(raw);
  }

  // Gmail requires matching subject and RFC reply headers for thread membership.
  const source = await resolveReplySource(
    params.account,
    params.client,
    target.threadId,
    params.replyToId,
  );
  if (!isAddressAllowed(source.senderEmail, params.account.allowTo)) {
    throw new Error(`Gmail recipient "${source.senderEmail}" is not allowed`);
  }
  const references = buildReferences(source);
  const raw = buildRawEmail({
    from: params.account.email,
    to: source.senderEmail,
    subject: buildReplySubject(source.subject),
    text: params.text,
    ...(source.messageIdHeader ? { inReplyTo: source.messageIdHeader } : {}),
    ...(references ? { references } : {}),
  });
  return await params.client.sendRawMessage(raw, target.threadId);
}
