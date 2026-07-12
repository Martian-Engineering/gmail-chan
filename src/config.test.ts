import { describe, expect, it } from "vitest";
import { GmailChannelConfigSchema } from "./config.js";

describe("GmailChannelConfigSchema", () => {
  it("rejects unknown account fields", () => {
    expect(() =>
      GmailChannelConfigSchema.parse({
        accounts: {
          work: {
            email: "agent@example.com",
            unexpected: true,
          },
        },
      }),
    ).toThrow();
  });

  it("applies conservative polling defaults", () => {
    const parsed = GmailChannelConfigSchema.parse({
      accounts: { work: { email: "agent@example.com" } },
    });

    expect(parsed.accounts.work?.pollIntervalSeconds).toBe(30);
    expect(parsed.accounts.work?.allowFrom).toEqual([]);
    expect(parsed.accounts.work?.allowTo).toEqual([]);
  });
});
