import { describe, expect, it } from "vitest";
import { normalizeGmailTarget, parseGmailTarget } from "./target.js";

describe("Gmail target grammar", () => {
  it("normalizes bare email addresses to mailto targets", () => {
    expect(normalizeGmailTarget(" Person@Example.com ")).toBe(
      "mailto:person@example.com",
    );
  });

  it("preserves Gmail thread identifiers", () => {
    expect(parseGmailTarget("thread:18f0abCDef12")).toEqual({
      kind: "thread",
      threadId: "18f0abCDef12",
    });
  });

  it("rejects malformed targets", () => {
    expect(normalizeGmailTarget("not-an-address")).toBeNull();
    expect(normalizeGmailTarget("thread:../mailbox")).toBeNull();
  });
});
