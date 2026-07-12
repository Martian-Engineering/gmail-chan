import { describe, expect, it } from "vitest";
import { gmailPlugin } from "./channel.js";

describe("gmailPlugin config", () => {
  it("exposes configured named accounts through the channel adapter", () => {
    const cfg = {
      channels: {
        gmail: {
          accounts: {
            work: {
              email: "agent@example.com",
              oauth: {
                clientId: "client-id",
                clientSecret: "client-secret",
                refreshToken: "refresh-token",
              },
            },
          },
        },
      },
    } as never;

    expect(gmailPlugin.config.listAccountIds(cfg)).toEqual(["work"]);
    expect(gmailPlugin.config.defaultAccountId?.(cfg)).toBe("work");
    expect(gmailPlugin.config.resolveAccount(cfg, "work")).toMatchObject({
      accountId: "work",
      configured: true,
      email: "agent@example.com",
    });
  });
});
