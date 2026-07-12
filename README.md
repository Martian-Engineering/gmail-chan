# gmail-chan

`gmail-chan` is an external [OpenClaw](https://github.com/openclaw/openclaw)
channel plugin that uses Gmail threads as conversations.

One Gmail thread maps to one OpenClaw session. Every email in that thread
continues the session, and a different Gmail thread creates a different session.

The `0.1.x` milestone supports plain-text messages through the Gmail API:

- poll unread inbox messages;
- admit senders through a deny-by-default allowlist;
- dispatch each Gmail thread through an isolated OpenClaw session;
- send the agent's result as a reply in the source Gmail thread;
- start a new Gmail thread through an explicit `mailto:` target;
- return Gmail message and thread IDs in durable OpenClaw receipts.

## Requirements

- OpenClaw `2026.7.2` or newer
- Node.js 22.19+, 23.11+, or 24+
- A Google Cloud project with the Gmail API enabled
- An OAuth 2.0 Desktop app client and refresh token

The plugin requests `https://www.googleapis.com/auth/gmail.modify`. Google
classifies this as a restricted scope because it permits reading messages,
sending messages, and changing labels. Review Google's
[Gmail scope documentation](https://developers.google.com/workspace/gmail/api/auth/scopes)
before distributing one OAuth client to other users.

## Install for development

```bash
git clone git@github.com:Martian-Engineering/gmail-chan.git
cd gmail-chan
pnpm install
pnpm build
openclaw plugins install --link "$PWD"
```

Published packages use `dist/index.js`. Linked source checkouts use `index.ts`,
which OpenClaw supports for local plugin development.

## Create Gmail credentials

1. Enable the Gmail API in a Google Cloud project.
2. Configure the OAuth consent screen for the account that owns the mailbox.
3. Create an OAuth client with application type **Desktop app**.
4. Obtain an offline refresh token for
   `https://www.googleapis.com/auth/gmail.modify` through an installed-app OAuth
   flow. Google's
   [desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app)
   documents the authorization-code and refresh-token exchange.
5. Store the client ID, client secret, and refresh token in environment variables
   or another OpenClaw secret provider.

For a single-operator development setup, the
[Google OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
can perform step 4 with **Use your own OAuth credentials** enabled. Do not use a
shared refresh token or commit one to this repository.

## Configure OpenClaw

Environment variables:

```bash
export GMAIL_CLIENT_ID='your-client-id.apps.googleusercontent.com'
export GMAIL_CLIENT_SECRET='your-client-secret'
export GMAIL_REFRESH_TOKEN='your-refresh-token'
```

OpenClaw config:

```json5
{
  channels: {
    gmail: {
      defaultAccount: "work",
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

Restart the OpenClaw gateway after changing channel configuration.

### Address policy

Both `allowFrom` and `allowTo` default to `[]`, which denies every address.

- `person@example.com` matches one address without case sensitivity.
- `@example.com` matches that domain and its subdomains.
- `*` matches every syntactically valid email address.

`allowFrom` controls messages delivered to the agent. `allowTo` controls new
outbound threads and replies. A permitted inbound sender must also be in
`allowTo` for the agent to reply.

## Targets and sessions

The shared OpenClaw `message` tool accepts two Gmail target forms:

- `thread:<gmail-thread-id>` replies in an existing Gmail thread.
- `mailto:<email-address>` starts a new Gmail thread with subject
  `OpenClaw message`.

Bare email addresses normalize to `mailto:` targets. Thread IDs require the
`thread:` prefix.

Inbound routing models each Gmail thread as an OpenClaw channel peer. This keeps
thread sessions isolated even when the operator's direct-message session policy
uses a shared main session.

Gmail assigns the canonical thread ID after a new outbound send. The plugin
returns that ID in the message receipt. Reconciliation between an
outbound-originated provisional OpenClaw route and the canonical Gmail thread
session remains tracked work.

## Delivery behavior

- Successfully dispatched messages are marked read.
- Self-authored and denied messages are not sent to the agent and are marked
  read, which prevents a denied message from producing a polling loop.
- A dispatch failure leaves the Gmail message unread for a later poll.
- Processing is sequential per account. An in-process guard prevents concurrent
  handling of one Gmail message ID.
- Gmail responses, MIME structures, headers, and bodies are validated and
  bounded before use.
- HTML email is reduced to text. Script and style blocks are removed; HTML is
  never executed.

The Gmail API groups replies by thread only when the request includes the thread
ID, the subject matches, and `References` plus `In-Reply-To` follow RFC 2822.
The plugin sets all three requirements. See Google's
[thread guide](https://developers.google.com/workspace/gmail/api/guides/threads)
and [sending guide](https://developers.google.com/workspace/gmail/api/guides/sending).

## Limitations

- Plain-text inbound and outbound content only
- One external reply recipient per thread; reply-all is not implemented
- No attachments or inline images
- No interactive OpenClaw OAuth wizard
- Polling only; no Gmail History API cursor or push notifications
- No automatic thread-history backfill into the model context
- New outbound messages use the fixed subject `OpenClaw message`

## Development

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm check
pnpm audit --audit-level high
npm pack --dry-run
```

Tests use fake Gmail API boundaries and do not require Google credentials or
network access.

The implementation targets OpenClaw `main` commit
`1318cf1fdef0f86fa186ab30be9f0a60e24c7868`, whose package version is
`2026.7.2`. See [docs/spec.md](docs/spec.md) for the contract and
[docs/plan.md](docs/plan.md) for the milestone task graph.

## License

MIT
