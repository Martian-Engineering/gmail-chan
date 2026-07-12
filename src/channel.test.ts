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

  it("builds one outbound session route per Gmail thread", () => {
    const resolveRoute = gmailPlugin.messaging?.resolveOutboundSessionRoute;
    expect(resolveRoute).toBeTypeOf("function");
    const params = {
      cfg: {} as never,
      agentId: "main",
      accountId: "work",
      target: "thread:thread-1",
    };
    const first = resolveRoute?.(params);
    const same = resolveRoute?.(params);
    const different = resolveRoute?.({ ...params, target: "thread:thread-2" });

    expect(first).toMatchObject({
      threadId: "thread-1",
      recipientSessionExact: true,
    });
    expect(same).toEqual(first);
    expect(different).not.toMatchObject({
      sessionKey: (first as { sessionKey: string }).sessionKey,
    });
    expect(
      resolveRoute?.({ ...params, target: "gmail:thread:thread-1" }),
    ).toEqual(first);
  });

  it("does not claim an email address is a canonical Gmail thread session", () => {
    const route = gmailPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {} as never,
      agentId: "main",
      accountId: "work",
      target: "mailto:person@example.com",
    });

    expect(route).toMatchObject({ recipientSessionExact: false });
  });

  it("exposes gateway and durable text and attachment adapters", () => {
    expect(gmailPlugin.gateway?.startAccount).toBeTypeOf("function");
    expect(gmailPlugin.message?.durableFinal?.capabilities).toMatchObject({
      text: true,
      media: true,
      replyTo: true,
      thread: true,
    });
    expect(gmailPlugin.message?.send?.media).toBeTypeOf("function");
    expect(gmailPlugin.outbound?.sendMedia).toBeTypeOf("function");
  });
});
