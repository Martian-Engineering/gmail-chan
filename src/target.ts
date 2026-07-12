const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const EMAIL_PATTERN = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u;

export type GmailTarget =
  { kind: "thread"; threadId: string } | { kind: "email"; email: string };

/** Normalizes a syntactically valid email address for matching and delivery. */
export function normalizeEmailAddress(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(normalized) ? normalized : null;
}

/** Parses the public Gmail target grammar into one typed variant. */
export function parseGmailTarget(value: string): GmailTarget | null {
  const trimmed = value.trim();
  if (trimmed.startsWith("thread:")) {
    const threadId = trimmed.slice("thread:".length);
    return THREAD_ID_PATTERN.test(threadId)
      ? { kind: "thread", threadId }
      : null;
  }

  const rawEmail = trimmed.startsWith("mailto:")
    ? trimmed.slice("mailto:".length)
    : trimmed;
  const email = normalizeEmailAddress(rawEmail);
  return email ? { kind: "email", email } : null;
}

/** Returns the canonical string form accepted by the channel adapters. */
export function normalizeGmailTarget(value: string): string | null {
  const target = parseGmailTarget(value);
  if (!target) {
    return null;
  }
  return target.kind === "thread"
    ? `thread:${target.threadId}`
    : `mailto:${target.email}`;
}

/** Builds the canonical target for one Gmail conversation. */
export function buildGmailThreadTarget(threadId: string): string {
  if (!THREAD_ID_PATTERN.test(threadId)) {
    throw new Error("Invalid Gmail thread ID");
  }
  return `thread:${threadId}`;
}
