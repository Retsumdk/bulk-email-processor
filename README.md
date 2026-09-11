# bulk-email-processor

[![CI](https://github.com/Retsumdk/bulk-email-processor/workflows/CI/badge.svg)](https://github.com/Retsumdk/bulk-email-processor/actions)
[![TypeScript](https://img.shields.io/badge/typescript-5.5-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/bun-%E2%89%A51.0-black.svg)](https://bun.sh)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

A dependency-free, send-ready bulk email engine: a real template language
(conditionals, loops, helpers, HTML auto-escaping), CSV recipient loading with
validation/dedup/suppression, a persistent retry queue with exponential backoff
and dead-lettering, sliding-window rate limiting, pluggable transports, and one
pipeline that turns a recipient list into a full `BatchReport`.

Built by [Retsumdk](https://github.com/Retsumdk). Zero runtime dependencies.

---

## Why this exists

Sending email to thousands of people is deceptively hard. Naive loops hammer
your provider, fail loudly the moment one address bounces, and HTML pages get
smuggled into a template the first time a field contains a `<script>` tag. Most
"bulk email" libraries are wrappers around a single SaaS provider and make you
write the retry, throttling, suppression, and templating glue yourself.

This library puts the operational core — queueing, retry, rate limiting, safe
templating — first, and keeps the actual transporter pluggable so nothing is
locked to one vendor.

## What's inside

| Concern | Implementation |
|---------|----------------|
| Templating | Recursive-descent parser → AST. `{{var}}`, `{{{raw}}}`, `{{#if}}`/`{{else}}`, `{{#unless}}`, `{{#each}}`, helpers, dot paths, HTML auto-escape. |
| Recipients | RFC-4180 CSV / JSON load, email validation, de-dup by address, suppression partition. |
| Queue | `Outbox`: FIFO, append-only JSONL persistence (crash-safe), in-flight tracking. |
| Retry | Exponential backoff + jitter-free determinism, `maxRetries`, dead-letter on exhaustion. |
| Rate limit | Sliding-window cap on sends/second. |
| Transports | `ConsoleProvider` (dry-run/log/sink), `HttpProvider` (any REST mail API), or a 2-method custom `MailProvider`. |
| Reporting | Single `runBatch()` → `BatchReport` with sent/failed/deferred/dead-lettered counts. |

## How it works

```
recipients.csv ──► loadRecipients ──► dedupe
      │                                  │
template.hbs  ──►  renderTemplate ──► expandMessages (1 Letter per recipient)
      │                                  │
      └─────────────── runBatch ─────────┘
                          │
                    [Outbox: persistent FIFO]
                          │
              sliding-window rate limiter  ◄── pacing
                          │
              sendOne(letter)  ──►  MailProvider  ──►  sent / failed / deferred
                          │            │
                    retry/backoff     dead-letter  ──►  BatchReport
```

`runBatch` enqueues the whole batch, then dispatches through a sliding-window
rate limiter. A success `ack`s the message; a transient failure re-queues it
with `backoffMs × 2^(attempt-1)`; a non-retryable failure or exhausted attempts
dead-letters it. The queue is backed by an append-only JSONL file when you pass
a `queuePath`, so a crash mid-run doesn't lose in-flight work.

## Getting started

```bash
git clone https://github.com/Retsumdk/bulk-email-processor.git
cd bulk-email-processor
bun install
```

### As a library

```ts
import { loadRecipients, dedupe, partition, runBatch, ConsoleProvider } from "bulk-email-processor";

const recipients = dedupe(loadRecipients("recipients.csv"));
const { sendable, suppressed } = partition(recipients, ["unsub@x.com"]);

const report = await runBatch({
  recipients: sendable,
  template: { subject: "Welcome {{name}}", text: "Hi {{name}}, your plan is {{plan}}" },
  provider: new ConsoleProvider(),
  send: { from: "noreply@example.com", ratePerSecond: 20, maxRetries: 3 },
});

console.log(`${report.sent} sent, ${report.failed} failed, ${report.deadLettered} dead-lettered`);
```

### The template language

```
Email:      {{ email }}
Name:       {{ name }}            (auto HTML-escaped)
Raw:        {{{ email }}}         (no escaping — use only with trusted data)
Condition:  {{#if active}} Pro member {{else}} Free {{/if}}
Loop:       {{#each teams}} - {{this}} {{/each}}
Helper:     {{upper name}}  {{lower tag}}  {{default plan "starter"}}
Nested:     {{#each users}}{{#if active}}{{name}};{{/if}}{{/each}}
Comment:    {{! visible only to readers of the template }}
```

Escaping is automatic: `render("<p>{{name}}</p>", { name: "<script>x()</script>" })`
produces `&lt;script&gt;…` so hostile data cannot inject markup into an HTML body.

### Command line

```bash
# Dry run — log each rendered message to the console
bun src/cli.ts send --template welcome.txt --recipients users.csv --from hello@example.com

# Validate a recipient file
bun src/cli.ts validate --recipients users.csv
# → OK users.csv: 3 sendable, 1 suppressed, 0 dropped/duplicate

# Dry run with a JSONL sink you can replay later
bun src/cli.ts send --template welcome.txt --recipients users.csv \
  --sink /tmp/sent.jsonl --rate 10

# Real delivery via any REST mail API
HTTP_MAIL_URL=https://api.resend.com/emails HTTP_MAIL_TOKEN=re_xxx \
bun src/cli.ts send --template welcome.txt --recipients users.csv --provider http
```

A template file looks like:

```
Subject: Welcome {{name}}

Hi {{name}},

Your plan is {{plan}}. Thanks for joining.
```

### Request body for HTTP delivery

`HttpProvider` POSTs JSON to your endpoint:

```json
{
  "to": "alice@example.com",
  "from": "hello@example.com",
  "subject": "Welcome Alice",
  "text": "Hi Alice, your plan is pro.",
  "html": "<p>Hi Alice, your plan is <b>pro</b>.</p>"
}
```

HTTP status codes are mapped onto retry semantics: `408`/`429`/`5xx` are
considered transient and retried; other failures dead-letter immediately.
Override the envelope with `buildBody` for provider-specific payloads.

## Custom transports

Any object with an `id` and a `send(letter)` is a valid provider:

```ts
const provider = {
  id: "ses",
  async send(letter) {
    // return { status: "sent" | "failed" | "deferred", retryable, detail? }
  },
};
```

Return `"deferred"` (with `retryable: true`) when the provider asks you to
re-try later, e.g. on a rate limit.

## API

- `loadRecipients(path)` – CSV or JSON → `Recipient[]` (invalid addresses dropped)
- `dedupe(recs)` – keep first occurrence per lower-cased email
- `partition(recs, extraBlocklist?)` – split `sendable` vs `suppressed`
- `renderTemplate(tpl, ctx)` – render subject/text/html with the template engine
- `runBatch({ recipients, template, provider, send, queuePath? })` – execute a run → `BatchReport`
- `Outbox` – persistent FIFO queue (in-memory or JSONL-backed)
- `ConsoleProvider`, `HttpProvider` – built-in transports
- `SendOptions`: `from`, `ratePerSecond?`, `maxRetries?`, `backoffMs?`, `timeoutMs?`, `sink?`

## Related

- [service-discovery-client](https://github.com/Retsumdk/service-discovery-client) — discover and load-balance outbound relays
- [audit-logger](https://github.com/Retsumdk/audit-logger) — immutable audit trails for sends
- [dead-letter-queue](https://github.com/Retsumdk/dead-letter-queue) — durable queue-pattern companion repo

## License

MIT © [Retsumdk](https://github.com/Retsumdk)
