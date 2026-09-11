/**
 * Console transport — logs every send and (optionally) appends rendered
 * messages to a JSONL sink. Used for dry runs, CI, and local development.
 * Never makes a network call.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import type { Letter, MailProvider } from "../types.ts";

export class ConsoleProvider implements MailProvider {
  readonly id = "console";

  private sink?: string;
  /** Collection of every rendered message (only grows in-memory during a run). */
  readonly log: Letter[] = [];

  constructor(opts?: { sink?: string }) {
    this.sink = opts?.sink ?? undefined;
    if (this.sink) {
      const i = this.sink.lastIndexOf("/");
      if (i > 0) mkdirSync(this.sink.slice(0, i), { recursive: true });
    }
  }

  async send(letter: Letter): Promise<{ status: "sent"; retryable: boolean; detail?: string }> {
    this.log.push(letter);
    const record = JSON.stringify({ at: new Date().toISOString(), ...letter });
    if (this.sink) appendFileSync(this.sink, `${record}\n`);
    else console.log(`[console-provider] to=${letter.to} subject=${JSON.stringify(letter.subject)}`);
    return { status: "sent", retryable: false, detail: "console" };
  }
}

/** Null transport — accepts everything, discards it. For unit tests. */
export class NullProvider implements MailProvider {
  readonly id = "null";
  sends = 0;
  async send(letter: Letter): Promise<{ status: "sent"; retryable: boolean; detail?: string }> {
    this.sends++;
    return { status: "sent", retryable: false, detail: "null" };
  }
}

/** Failing transport — always fails, used to test retry/dead-letter logic. */
export class ExplodingProvider implements MailProvider {
  readonly id = "explode";
  calls = 0;
  constructor(private retryable = true, private message = "boom") {}
  async send(letter: Letter): Promise<{ status: "failed"; retryable: boolean; detail: string }> {
    this.calls++;
    return { status: "failed", retryable: this.retryable, detail: this.message };
  }
}
