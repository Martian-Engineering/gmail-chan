# Gmail Chan Implementation Plan

## Overview

The first milestone builds one text-only path through Gmail and OpenClaw. The
work starts with a package that loads against the OpenClaw `2026.7.2` channel
contract, then adds configuration, Gmail transport, inbound dispatch, and final
package validation.

## Architecture Decisions

- Gmail thread IDs are channel peer IDs. Channel routing prevents OpenClaw DM
  scope settings from merging unrelated email threads.
- Gmail API access sits behind a small interface so tests use a fake without
  network calls or OAuth credentials.
- `gmail.modify` supplies read, send, and label mutation in one scope. The README
  identifies Google's restricted-scope verification requirements.
- The first milestone sends plain-text MIME. This keeps untrusted HTML out of
  outbound rendering and limits dependencies.
- Sender and recipient policy deny by default. Exact addresses and domain
  suffixes are the only supported match forms.

## Task List

### Foundation

#### `gmail-883.1`: Scaffold the modern OpenClaw plugin package

Create package metadata, the manifest, TypeScript and test configuration, the
entry contract, and CI.

Acceptance criteria:

- `defineChannelPluginEntry` owns channel registration.
- Package metadata declares OpenClaw API `2026.7.2` compatibility.
- Entry-shape tests, type checking, and build pass.

Verification:

```bash
pnpm test
pnpm typecheck
pnpm build
```

Likely files: `package.json`, `openclaw.plugin.json`, `index.ts`, `tsconfig.json`,
`vitest.config.ts`, `.github/workflows/ci.yml`.

### Configuration and Policy

#### `gmail-883.2`: Implement secure Gmail account configuration

Add strict channel schemas, OpenClaw secret-input resolution, target parsing,
and address policy.

Acceptance criteria:

- Default and named accounts resolve through one path.
- Missing secrets report unavailable status without exposing secret values.
- Invalid targets and denied addresses fail closed.

Verification:

```bash
pnpm test -- src/config.test.ts src/accounts.test.ts src/target.test.ts src/policy.test.ts
pnpm typecheck
```

Dependencies: `gmail-883.1`.

### Gmail Transport

#### `gmail-883.3`: Implement Gmail API message transport

Add the Gmail client boundary, bounded message parsing, unread label operations,
and MIME construction for new messages and replies.

Acceptance criteria:

- Gmail responses are validated before use.
- MIME parsing prefers `text/plain` and uses bounded text extraction for HTML.
- Replies carry `threadId`, matching subject, `In-Reply-To`, and `References`.

Verification:

```bash
pnpm test -- src/message.test.ts src/gmail-client.test.ts
pnpm typecheck
pnpm audit --audit-level high
```

Dependencies: `gmail-883.2`.

### OpenClaw Routing

#### `gmail-883.4`: Route polled Gmail threads through OpenClaw

Add gateway polling, inbound admission, channel session routing, reply dispatch,
and durable outbound receipts.

Acceptance criteria:

- One Gmail thread reuses one route session and different threads stay isolated.
- Self-authored and denied messages do not dispatch.
- Successful dispatch marks the source message read; failed dispatch leaves it
  unread.
- Agent replies remain in the source Gmail thread.

Verification:

```bash
pnpm test -- src/gateway.test.ts src/inbound.test.ts src/channel.test.ts
pnpm typecheck
pnpm build
```

Dependencies: `gmail-883.3`.

### Package Proof

#### `gmail-883.5`: Document, package, and validate the first milestone

Document setup, security properties, target grammar, and limitations. Pack the
plugin and inspect it against the local OpenClaw checkout.

Acceptance criteria:

- README contains a reproducible OAuth and OpenClaw configuration path.
- The package archive contains built runtime files, manifest, README, and license.
- OpenClaw runtime inspection recognizes the `gmail` channel.
- Full validation and review complete without unresolved high-impact findings.

Verification:

```bash
pnpm check
npm pack --dry-run
pnpm openclaw:inspect
```

Dependencies: `gmail-883.4`.

## Checkpoints

After `gmail-883.2`:

- The package builds against the API floor.
- Configuration and policy tests pass.
- No secret values appear in staged changes.

After `gmail-883.4`:

- The fake Gmail integration completes an inbound-to-reply flow.
- Session routing tests prove thread isolation.
- Full test, type, lint, and build commands pass.

Before closing `gmail-883`:

- The packed artifact loads through OpenClaw's external-plugin path.
- Strict maintainability review and autoreview have no unresolved findings.
- Deferred work remains in pebbles rather than placeholder code.

## Risks and Mitigations

| Risk                                                | Impact                                                     | Mitigation                                                                                              |
| --------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| OpenClaw API changes before `2026.7.2` release      | Build or runtime load fails                                | Pin the development SHA in docs and run inspection against OpenClaw `main`                              |
| Gmail assigns a thread ID after a new outbound send | Outbound-origin session may start with a provisional route | Return the canonical thread ID in the receipt and test host reconciliation before claiming full support |
| Restricted Gmail scope requires verification        | Public OAuth app setup takes additional work               | Document operator-owned OAuth clients and scope classification                                          |
| Duplicate unread polling after a crash              | One email may dispatch more than once                      | Use in-process dedupe for concurrency and track durable History API cursors as a follow-up              |
| Email content contains prompt injection             | Agent may act on hostile instructions                      | Treat bodies as user input and rely on OpenClaw permissions; never elevate authority from email content |
