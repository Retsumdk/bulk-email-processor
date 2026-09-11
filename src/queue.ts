/**
 * Persistent FIFO send queue (Outbox).
 *
 * Holds the expanded per-recipient send units. Supports in-memory operation
 * (default) or append-only JSONL disk persistence for crash-safe restart
 * and backfill from a previous interrupted run. Deferred messages (waiting
 * out retry backoff) are tracked so a dispatched pipeline can sleep exactly
 * until the next message becomes eligible instead of busy-polling.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

/** A single queued send unit (fully rendered, ready to transport). */
export interface QueuedMessage {
  id: string;
  to: string;
  from: string;
  subject: string;
  html?: string;
  text?: string;
  attempts: number;
  /** When set and in the future, the message is deferred and not eligible. */
  dueAt?: number;
  /** Enqueue timestamp — used for FIFO ordering. */
  enqueuedAt: number;
}

export type { QueuedMessage as Mail };

/** Append-only JSONL Outbox (":memory:" disables persistence). */
export class Outbox {
  private messages = new Map<string, QueuedMessage>();
  private path?: string;

  constructor(path = ":memory:") {
    if (path && path !== ":memory:") {
      this.path = path;
      if (existsSync(path)) {
        for (const line of readFileSync(path, "utf-8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const m = JSON.parse(line) as QueuedMessage;
            this.messages.set(m.id, m);
          } catch {
            /* ignore a corrupt trailing line (crash mid-write) */
          }
        }
      }
    }
  }

  get size(): number {
    return this.messages.size;
  }

  get isEmpty(): boolean {
    return this.messages.size === 0;
  }

  add(msg: QueuedMessage): void {
    this.messages.set(msg.id, msg);
    this.persist(msg);
  }

  /** Next eligible (non-deferred) message in FIFO (earliest enqueued) order. */
  next(): QueuedMessage | undefined {
    const now = Date.now();
    let best: QueuedMessage | undefined;
    for (const m of this.messages.values()) {
      if (m.dueAt !== undefined && m.dueAt > now) continue;
      if (!best || m.enqueuedAt < best.enqueuedAt) best = m;
    }
    return best;
  }

  /** Remove a delivered message. */
  ack(id: string): void {
    this.messages.delete(id);
  }

  /** Re-queue after a failure, applying backoff. Shared message is returned. */
  requeue(msg: QueuedMessage, backoffMs = 0): QueuedMessage {
    const updated: QueuedMessage = {
      ...msg,
      attempts: msg.attempts + 1,
      dueAt: Date.now() + backoffMs,
    };
    this.messages.set(updated.id, updated);
    this.persist(updated);
    return updated;
  }

  remaining(): number {
    return this.messages.size;
  }

  /** Earliest deferral time among queued messages, if any. */
  pendingDueAt(): number | undefined {
    let earliest: number | undefined;
    for (const m of this.messages.values()) {
      if (m.dueAt === undefined) continue;
      if (earliest === undefined || m.dueAt < earliest) earliest = m.dueAt;
    }
    return earliest;
  }

  /** Snapshot ordered by enqueue time (for inspection/debug). */
  snapshot(): QueuedMessage[] {
    return [...this.messages.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  private persist(msg: QueuedMessage): void {
    if (!this.path) return;
    const slash = this.path.lastIndexOf("/");
    if (slash > 0) mkdirSync(this.path.slice(0, slash), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(msg)}\n`, "utf-8");
  }
}
