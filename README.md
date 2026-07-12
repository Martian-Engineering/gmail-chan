# gmail-chan

`gmail-chan` is an external [OpenClaw](https://github.com/openclaw/openclaw)
channel plugin that uses Gmail threads as conversations.

One Gmail thread maps to one OpenClaw session. Every email in that thread
continues the session, and a different Gmail thread creates a different session.

The plugin supports text and file attachments through the Gmail API:

- poll unread inbox messages;
- admit senders through a deny-by-default allowlist;
- dispatch each Gmail thread through an isolated OpenClaw session;
- send the agent's result as a reply in the source Gmail thread;
- reply to all permitted `Reply-To`, `To`, and `Cc` participants;
- make inbound attachments available through OpenClaw managed media;
- send OpenClaw media as Gmail attachments;
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
5. Store the client ID, client secret, and refresh token as environment-backed
   OpenClaw secret inputs.

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
outbound threads and every reply-all recipient. The plugin checks `Reply-To`,
`To`, and `Cc` before agent dispatch. One denied recipient rejects the message,
which prevents agent work followed by an undeliverable response. Admission also
requires a Google-generated `Authentication-Results` header with aligned DMARC
success for the normalized `From` domain. Mail from domains without passing
DMARC is ignored.

## Targets and sessions

The shared OpenClaw `message` tool accepts two Gmail target forms:

- `thread:<gmail-thread-id>` replies in an existing Gmail thread.
- `mailto:<email-address>` starts a new Gmail thread with subject
  `OpenClaw message`.

OpenClaw-qualified forms such as `gmail:thread:<gmail-thread-id>` and
`gmail:mailto:<email-address>` normalize to the same targets.

Bare email addresses normalize to `mailto:` targets. Thread IDs require the
`thread:` prefix.

Inbound routing models each Gmail thread as an OpenClaw channel peer. This keeps
thread sessions isolated even when the operator's direct-message session policy
uses a shared main session.

Gmail assigns the canonical thread ID after a new outbound send. The plugin
stores the initial outbound text under that returned ID. The first inbound reply
adds the opener as structured context to the canonical `thread:` session. Two
new threads to the same address remain separate because the address is not used
as the session identity.

## Delivery behavior

- Successfully dispatched messages are marked read.
- Self-authored and denied messages are not sent to the agent and are marked
  read, which prevents a denied message from producing a polling loop.
- A dispatch failure leaves the Gmail message unread for a later poll.
- Processing is sequential per account. An in-process guard prevents concurrent
  handling of one Gmail message ID.
- The gateway polls at `pollIntervalSeconds`, which defaults to 30 seconds. Push
  notification infrastructure is not required.
- Gmail responses, MIME structures, headers, and bodies are validated and
  bounded before use.
- Inbound attachments are limited to 10 files, 10 MiB per file, and 20 MiB in
  total. OpenClaw stores accepted files in its managed inbound media directory.
- OpenClaw media output is loaded through the host's guarded local/remote media
  policy and sent as multipart MIME. Multiple output files can produce multiple
  Gmail messages in the same thread.
- HTML email is reduced to text. Script and style blocks are removed; HTML is
  never executed.

The Gmail API groups replies by thread only when the request includes the thread
ID, the subject matches, and `References` plus `In-Reply-To` follow RFC 2822.
The plugin sets all three requirements. See Google's
[thread guide](https://developers.google.com/workspace/gmail/api/guides/threads)
and [sending guide](https://developers.google.com/workspace/gmail/api/guides/sending).
If the source message has no `Message-ID`, the plugin fails closed instead of
claiming a reply that Gmail may place in a different thread.

## Limitations

- Plain-text message bodies; HTML inbound mail is converted to text
- Inline images are handled as attachments when Gmail supplies a filename
- OAuth credentials and the refresh token must be obtained before configuration;
  the plugin does not run a browser-based setup wizard
- Polling delivery; no Gmail Pub/Sub deployment is required
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
`5f9a6ce7eb53e1003255278d1ef39ec4dc82c991`, whose package version is
`2026.7.2`. See [docs/spec.md](docs/spec.md) for the contract and
[docs/plan.md](docs/plan.md) for the milestone task graph.

## License

MIT
