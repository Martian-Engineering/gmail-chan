import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

const THREAD_CONTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_PENDING_THREADS = 1_000;

export type PendingOutboundThreadContext = {
  accountId: string;
  threadId: string;
  text: string;
  createdAt: number;
};

function contextKey(accountId: string, threadId: string): string {
  return `${accountId}:${threadId}`;
}

function openThreadContextStore(runtime: PluginRuntime) {
  return runtime.state.openKeyedStore<PendingOutboundThreadContext>({
    namespace: "gmail-outbound-thread-context",
    maxEntries: MAX_PENDING_THREADS,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: THREAD_CONTEXT_TTL_MS,
  });
}

/** Persists the opener for a Gmail thread created by an outbound send. */
export async function recordOutboundThreadContext(params: {
  runtime: PluginRuntime;
  accountId: string;
  threadId: string;
  text: string;
  now?: number;
}): Promise<void> {
  await openThreadContextStore(params.runtime).register(
    contextKey(params.accountId, params.threadId),
    {
      accountId: params.accountId,
      threadId: params.threadId,
      text: params.text,
      createdAt: params.now ?? Date.now(),
    },
  );
}

/** Atomically takes a pending outbound opener before the first inbound reply. */
export async function takeOutboundThreadContext(params: {
  runtime: PluginRuntime;
  accountId: string;
  threadId: string;
}): Promise<PendingOutboundThreadContext | undefined> {
  return await openThreadContextStore(params.runtime).consume(
    contextKey(params.accountId, params.threadId),
  );
}
