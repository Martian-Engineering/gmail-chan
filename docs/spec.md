# Gmail Chan Specification

## Objective

`gmail-chan` is an external OpenClaw channel plugin that uses Gmail threads as
conversations. Each Gmail thread maps to one OpenClaw session. Messages in the
same thread reuse that session, and messages in different threads use different
sessions.

The first milestone supports text email through the Gmail API. It polls unread
inbox messages, applies sender policy, dispatches admitted messages to OpenClaw,
and sends the agent's response as a reply in the source Gmail thread.

## Tech Stack

- Node.js 22.19 or newer
- TypeScript ESM
- OpenClaw plugin API `2026.7.2`
- `@googleapis/gmail` for Gmail API calls
- Zod 4 for config and API-boundary validation
- Vitest for unit and contract tests
- pnpm for development and CI

## Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm check
pnpm pack
```

Local OpenClaw validation:

```bash
pnpm openclaw:link
pnpm openclaw:inspect
```

## Project Structure

```text
index.ts                 Plugin runtime entry
openclaw.plugin.json     Cold-path manifest and channel schema
src/accounts.ts          Account config and secret resolution
src/channel.ts           Channel contract and outbound adapters
src/config.ts            Zod schemas and public config types
src/gateway.ts           Polling account lifecycle
src/gmail-client.ts      Gmail API boundary
src/inbound.ts           OpenClaw ingress and reply dispatch
src/message.ts           MIME parsing and construction
src/policy.ts            Inbound and outbound address policy
src/runtime.ts           Host-provided runtime store
src/target.ts            Gmail target grammar
tests/                   Cross-module and contract tests
docs/                    Specification and implementation plan
```

## Public Contracts

### Channel ID

The channel ID is `gmail`.

### Targets

- `thread:<gmail-thread-id>` replies to an existing Gmail thread.
- `mailto:<email-address>` starts a new Gmail thread.

Bare email addresses normalize to `mailto:` targets. Bare Gmail thread IDs do
not normalize because an email local part can have a similar shape.

### Account Configuration

```json5
{
  channels: {
    gmail: {
      accounts: {
        work: {
          email: "agent@example.com",
          oauth: {
            clientId: {
              source: "env",
              provider: "default",
              id: "GMAIL_CLIENT_ID",
            },
            clientSecret: {
              source: "env",
              provider: "default",
              id: "GMAIL_CLIENT_SECRET",
            },
            refreshToken: {
              source: "env",
              provider: "default",
              id: "GMAIL_REFRESH_TOKEN",
            },
          },
          allowFrom: ["person@example.com", "@martian.engineering"],
          allowTo: ["person@example.com", "@martian.engineering"],
          pollIntervalSeconds: 30,
        },
      },
    },
  },
}
```

`allowFrom` and `allowTo` default to empty arrays. Empty policy denies all
addresses. `"*"` allows every syntactically valid address. Entries beginning
with `@` match one domain and its subdomains by suffix boundary.

The plugin uses the `gmail.modify` OAuth scope. Google classifies this as a
restricted scope because the plugin reads message bodies and changes labels.

## Message Lifecycle

1. The gateway lists `in:inbox is:unread` messages.
2. The Gmail client fetches each full message and validates required IDs and
   bounded header/body fields.
3. The plugin ignores messages sent by the configured mailbox.
4. Sender policy admits or rejects the normalized `From` address.
5. The runtime builds a channel route with `thread:<gmail-thread-id>` as the
   peer ID.
6. OpenClaw dispatches the message in the route's session.
7. Agent output is sent with the Gmail thread ID and RFC reply headers.
8. The plugin removes the `UNREAD` label after dispatch completes.

Rejected senders are marked read so a denied message does not create a hot poll
loop. Dispatch failures leave messages unread for a later poll.

## Code Style

Public functions and types include purpose comments. Modules expose a narrow
boundary and keep transport, policy, parsing, and OpenClaw runtime logic
separate.

```typescript
/** Returns whether a normalized email address is admitted by one policy list. */
export function isAddressAllowed(
  address: string,
  entries: readonly string[],
): boolean {
  return entries.some((entry) => matchesAddressPolicy(address, entry));
}
```

Use focused imports such as `openclaw/plugin-sdk/channel-core`. Do not import
the deprecated `openclaw/plugin-sdk` root barrel.

## Testing Strategy

- Unit tests cover target parsing, address policy, MIME parsing, and MIME output.
- Boundary tests use a fake Gmail transport. Tests do not call Google services.
- Channel tests prove account resolution and session routing.
- Inbound tests prove sender denial, self-message suppression, marking behavior,
  same-thread session reuse, and cross-thread isolation.
- Package validation builds JavaScript, runs `npm pack --dry-run`, and inspects
  the linked plugin with the local OpenClaw checkout.

Each behavior test is written before its implementation and must fail for the
expected reason before production code is added.

## Boundaries

Always:

- Validate Gmail API data before use.
- Keep OAuth values out of logs, errors, fixtures, and Git history.
- Apply deny-by-default sender and recipient policy.
- Limit message body and header sizes before model dispatch.
- Return Gmail message and thread IDs in outbound receipts.
- Run tests, type checking, linting, and the build before commits.

Ask first:

- Add an OAuth callback server or another authentication flow.
- Add Gmail push notifications or public webhook infrastructure.
- Add dependencies beyond the Gmail client, Zod, and development tools.
- Add attachment persistence or forward full thread history to the model.

Never:

- Execute email HTML or instructions as code.
- Log message bodies, OAuth credentials, or refresh tokens.
- Shell out to a mail CLI.
- Mark a failed dispatch as read.
- Copy source from a repository without a clear committed license.

## Success Criteria

- OpenClaw loads the plugin through `defineChannelPluginEntry` on API
  `2026.7.2`.
- Two messages with one Gmail thread ID resolve to one session key.
- Messages with different Gmail thread IDs resolve to different session keys.
- A permitted unread email reaches OpenClaw and receives a reply in its Gmail
  thread.
- Self-authored and denied messages do not reach the agent.
- A new outbound email returns its Gmail thread ID in a durable receipt.
- The package builds, tests, packs, and passes OpenClaw runtime inspection.

## Deferred Work

- Interactive desktop OAuth onboarding
- Attachments and inline images
- HTML-rich outbound email
- Reply-all and multi-recipient policy
- Gmail History API and push notifications
- Full thread-history context
- Proven session reconciliation for outbound-originated Gmail threads
