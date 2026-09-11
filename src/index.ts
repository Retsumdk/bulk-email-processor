/**
 * bulk-email-processor — queue-based bulk email processing with templates.
 *
 * A dependency-free, send-ready bulk email engine: a real template engine
 * (conditionals, loops, helpers, HTML auto-escaping), CSV recipient loading
 * with validation/dedup/suppression, a persistent FIFO outbox with retry
 * backoff and dead-lettering, sliding-window rate limiting, pluggable
 * transports (console/log-only or any REST mail API), and a batch pipeline
 * that reports sent/failed/deferred/dead-lettered counts.
 *
 * Built by Retsumdk.
 */
export type {
  Recipient,
  Letter,
  SendStatus,
  SendResult,
  MailProvider,
  BatchReport,
  TemplateBundle,
  SendOptions,
} from "./types.ts";

export { Outbox } from "./queue.ts";
export type { QueuedMessage } from "./queue.ts";

export { parseCsv, tokenizeCsv, rowsToRecipients, loadRecipients, dedupe, partition, ctxFor } from "./recipients.ts";
export { parse, render, renderTemplate } from "./template.ts";

export { ConsoleProvider, HttpProvider } from "./providers/index.ts";
export type { HttpProviderOptions } from "./providers/http.ts";

export { runBatch, retryDelayMs } from "./pipeline.ts";
