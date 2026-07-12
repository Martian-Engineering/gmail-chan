import { describe, expect, it } from "vitest";
import {
  inspectGmailAccount,
  listGmailAccountIds,
  resolveDefaultGmailAccountId,
  resolveGmailAccount,
  type GmailCoreConfig,
} from "./accounts.js";

const config = {
  channels: {
    gmail: {
      defaultAccount: "work",
      accounts: {
        work: {
          email: "Agent@Example.com",
          oauth: {
            clientId: {
              source: "env",
              provider: "default",
              id: "TEST_GMAIL_CLIENT_ID",
            },
            clientSecret: {
              source: "env",
              provider: "default",
              id: "TEST_GMAIL_CLIENT_SECRET",
            },
            refreshToken: {
              source: "env",
              provider: "default",
              id: "TEST_GMAIL_REFRESH_TOKEN",
            },
          },
          allowFrom: ["person@example.com"],
          allowTo: ["@example.com"],
        },
      },
    },
  },
} satisfies GmailCoreConfig;

describe("Gmail account resolution", () => {
  it("lists named accounts and resolves the configured default", () => {
    expect(listGmailAccountIds(config)).toEqual(["work"]);
    expect(resolveDefaultGmailAccountId(config)).toBe("work");
  });

  it("resolves env-backed OAuth inputs without changing config", () => {
    const account = resolveGmailAccount({
      cfg: config,
      env: {
        TEST_GMAIL_CLIENT_ID: "client-id",
        TEST_GMAIL_CLIENT_SECRET: "client-secret",
        TEST_GMAIL_REFRESH_TOKEN: "refresh-token",
      },
    });

    expect(account).toMatchObject({
      accountId: "work",
      email: "agent@example.com",
      configured: true,
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      allowFrom: ["person@example.com"],
      allowTo: ["@example.com"],
    });
  });

  it("inspects configuration without returning secret values", () => {
    const inspection = inspectGmailAccount(config, "work");

    expect(inspection).toEqual({
      accountId: "work",
      enabled: true,
      configured: true,
      email: "agent@example.com",
      oauth: {
        clientId: "configured",
        clientSecret: "configured",
        refreshToken: "configured",
      },
    });
    expect(JSON.stringify(inspection)).not.toContain(
      "TEST_GMAIL_CLIENT_SECRET",
    );
  });
});
