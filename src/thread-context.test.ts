import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import {
  recordOutboundThreadContext,
  takeOutboundThreadContext,
} from "./thread-context.js";

function createRuntime() {
  const values = new Map<string, unknown>();
  const store = {
    register: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
    }),
    consume: vi.fn(async (key: string) => {
      const value = values.get(key);
      values.delete(key);
      return value;
    }),
  };
  const runtime = {
    state: { openKeyedStore: () => store },
  } as unknown as PluginRuntime;
  return { runtime, values };
}

describe("outbound Gmail thread context", () => {
  it("keeps two new threads to one recipient in separate records", async () => {
    const { runtime } = createRuntime();
    await recordOutboundThreadContext({
      runtime,
      accountId: "work",
      threadId: "thread-1",
      text: "First opener",
      now: 1,
    });
    await recordOutboundThreadContext({
      runtime,
      accountId: "work",
      threadId: "thread-2",
      text: "Second opener",
      now: 2,
    });

    await expect(
      takeOutboundThreadContext({
        runtime,
        accountId: "work",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({ text: "First opener" });
    await expect(
      takeOutboundThreadContext({
        runtime,
        accountId: "work",
        threadId: "thread-2",
      }),
    ).resolves.toMatchObject({ text: "Second opener" });
  });
});
