/**
 * Public type definitions for bulk-email-processor.
 * Zero dependencies.
 */

/** A normalized recipient loaded from a list / parsed from rows. */
export interface Recipient {
  /** Primary delivery address (always present, trimmed). */
  email: string;
  /** Optional display name used by `{{name}}`. */
  name?: string;
  /** Free-form personalization variables available to templates. */
  vars?: Record<string, unknown>;
  /** True when the address is on a do-not-contact list. */
  suppressed?: boolean;
}

/** A rendered, ready-to-send message. */
export interface Letter {
  to: string;
  from: string;
  subject: string;
  /** HTML body when the template defines one. */
  html?: string;
  /** Plain-text body. */
  text?: string;
}

/** Result of a single send attempt. */
export type SendStatus = "sent" | "failed" | "deferred";

export interface SendResult {
  to: string;
  status: SendStatus;
  providerId: string;
  /** A transient error that may succeed on retry (rate-limit / timeout). */
  retryable: boolean;
  /** Human-readable detail (provider message / error). */
  detail?: string;
  /** Wall-clock duration of the attempt in ms. */
  tookMs: number;
  /** Number of prior attempts for this message. */
  attempt: number;
}

/** Contract every mail transport must satisfy. */
export interface MailProvider {
  readonly id: string;
  /**
   * Send a rendered letter to a single recipient. Must settle and return a
   * status; throwing is caught and treated as a retryable failure.
   */
  send(letter: Letter): Promise<Pick<SendResult, "status" | "retryable" | "detail">>;
}

/** Aggregated report for a single batch run. */
export interface BatchReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  totalScheduled: number;
  suppressed: number;
  attempted: number;
  sent: number;
  failed: number;
  deferred: number;
  deadLettered: number;
  ratePerSecond: number;
  results: SendResult[];
}

/** A template bundle: subject plus optional html/text body. */
export interface TemplateBundle {
  subject: string;
  html?: string;
  text?: string;
}

/** Outgoing send policy. */
export interface SendOptions {
  from: string;
  /** Cap on sends per second (sliding window). Default unlimited. */
  ratePerSecond?: number;
  /** Max attempts per message before dead-lettering. Default 3. */
  maxRetries?: number;
  /** Base backoff in ms, doubled per retry. Default 1000. */
  backoffMs?: number;
  /** Abort a transport call after this many ms. Default 30_000. */
  timeoutMs?: number;
  /** Optional sink file for a ConsoleProvider dry run. */
  sink?: string;
}
