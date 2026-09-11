/**
 * Batch send pipeline.
 *
 * Turns a set of recipients + a template into a dispatch run:
 * render → enqueue → rate-limited dispatch with retry/backoff → dead-letter.
 * Produces a `BatchReport` for the whole run.
 */
import { Outbox, type QueuedMessage } from "./queue.ts";
import { ctxFor } from "./recipients.ts";
import { renderTemplate } from "./template.ts";
import type { BatchReport, Letter, MailProvider, Recipient, SendOptions, SendResult, TemplateBundle } from "./types.ts";

/** Base backoff in ms, doubled per retry. */
export function retryDelayMs(baseMs: number, attempt: number): number {
  const exp = Math.pow(2, Math.min(Math.max(0, attempt - 1), 62));
  // Clamp so a runaway attempt count cannot overflow (max ~ 4.7 days).
  return Math.min(baseMs * exp, 7 * 24 * 60 * 60 * 1000);
}

/** Convert a recipient into a queued, personalized Letter-list. */
export function expandMessages(
  recipients: Recipient[],
  template: TemplateBundle,
  from: string,
): Letter[] {
  return recipients.map((r) => {
    const ctx = ctxFor(r);
    const rendered = renderTemplate(template, ctx);
    const letter: Letter = { to: r.email, from, subject: rendered.subject };
    if (rendered.html) letter.html = rendered.html;
    if (rendered.text) letter.text = rendered.text;
    return letter;
  });
}

interface RunBatchInput {
  recipients: Recipient[];
  template: TemplateBundle;
  send: SendOptions;
  provider: MailProvider;
  /** Optional JSONL path to persist the queue (crash-safe). */
  queuePath?: string;
  /** Number of recipients suppressed before the run (for the report). */
  suppressedCount?: number;
  /** Randomness source override for tests. */
  rand?: () => number;
}

/** Execute a full bulk-send run. */
export async function runBatch(input: RunBatchInput): Promise<BatchReport> {
  const { recipients, template, send, provider, queuePath } = input;
  const suppressed = input.suppressedCount ?? 0;
  const runId = `run-${Date.now()}-${Math.floor(input.rand ? input.rand() * 1e6 : Math.random() * 1e6)}`;
  const startedAt = new Date().toISOString();
  const ratePerSecond = send.ratePerSecond ?? Infinity;
  const maxRetries = send.maxRetries ?? 3;
  const backoffMs = send.backoffMs ?? 1000;
  const timeoutMs = send.timeoutMs ?? 30_000;
  const rand = input.rand ?? Math.random;

  const outbox = new Outbox(queuePath);
  const letters = expandMessages(recipients, template, send.from);
  const results: SendResult[] = [];
  let sent = 0;
  let failed = 0;
  let deferred = 0;
  let deadLettered = 0;

  // Enqueue the whole batch up front (so persistence + counts are accurate).
  const now = Date.now();
  letters.forEach((lt, idx) => {
    outbox.add({
      id: `${runId}-${idx}`,
      to: lt.to,
      from: lt.from,
      subject: lt.subject,
      html: lt.html,
      text: lt.text,
      attempts: 1,
      enqueuedAt: now + idx,
    });
  });

  async function sendOne(m: QueuedMessage): Promise<SendResult> {
    const started = Date.now();
    const letter: Letter = { to: m.to, from: m.from, subject: m.subject };
    if (m.html) letter.html = m.html;
    if (m.text) letter.text = m.text;
    let outcome: Pick<SendResult, "status" | "retryable" | "detail">;
    try {
      outcome = await withTimeout(provider.send(letter), timeoutMs);
    } catch (err) {
      outcome = {
        status: "failed",
        retryable: true,
        detail: `transport error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const tookMs = Date.now() - started;
    return { to: m.to, status: outcome.status, providerId: provider.id, retryable: outcome.retryable, detail: outcome.detail, tookMs, attempt: m.attempts };
  }

  // Sliding-window rate limiter: at most ratePerSecond invocations per 1000ms.
  const timestamps: number[] = [];
  async function throttle(): Promise<void> {
    if (!Number.isFinite(ratePerSecond) || ratePerSecond <= 0) return;
    while (timestamps.length && Date.now() - timestamps[0]! >= 1000) timestamps.shift();
    const current = timestamps.map((t) => t).length;
    // Allow an initial burst equal to the rate.
    if (current > Math.max(1, Math.floor(ratePerSecond))) {
      const waitMs = 1000 - (Date.now() - timestamps[0]!);
      if (waitMs > 0) await sleep(waitMs);
      await throttle();
    }
    timestamps.push(Date.now());
  }

  // Dispatch loop.
  while (!outbox.isEmpty) {
    const m = outbox.next();
    if (!m) {
      // All remaining are deferred — wait for the earliest due time.
      const due = outbox.pendingDueAt();
      if (due !== undefined && due > Date.now()) await sleep(Math.min(due - Date.now(), 1000));
      continue;
    }
    await throttle();
    const res = await sendOne(m);
    results.push(res);
    switch (res.status) {
      case "sent":
        outbox.ack(m.id);
        sent++;
        break;
      case "deferred":
        // Provider asked us to retry later — leave it queued with backoff.
        deferred++;
        outbox.requeue(m, retryDelayMs(backoffMs, m.attempts));
        break;
      case "failed":
        if (res.retryable && m.attempts <= maxRetries) {
          outbox.requeue(m, retryDelayMs(backoffMs, m.attempts)); // will retry
        } else {
          // Permanent failure: non-retryable error, or retries exhausted.
          outbox.ack(m.id);
          failed++;
          deadLettered++;
        }
        break;
    }
  }

  const finishedAt = new Date().toISOString();
  const elapsedSec = Math.max(1e-6, (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000);
  return {
    runId,
    startedAt,
    finishedAt,
    totalScheduled: recipients.length,
    suppressed,
    attempted: results.length,
    sent,
    failed,
    deferred,
    deadLettered,
    ratePerSecond,
    results,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => id && clearTimeout(id));
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
