/**
 * HTTP transport — a generic adapter for REST email APIs (e.g. Resend,
 * SendGrid, Postmark, Mailgun). Posts a JSON payload with a bearer token and
 * maps HTTP status codes onto retryable/non-retryable failures.
 * Zero dependencies (uses global `fetch`).
 */
import type { Letter, MailProvider } from "../types.ts";

export interface HttpProviderOptions {
  /** Endpoint that accepts `POST {to,from,subject,text,html}`. */
  url: string;
  /** Bearer token sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Timeout for each request in ms. Default 30_000. */
  timeoutMs?: number;
  /** Override the request body (e.g. provider-specific envelope). */
  buildBody?: (letter: Letter) => unknown;
}

export class HttpProvider implements MailProvider {
  readonly id = "http";
  private url: string;
  private token?: string;
  private timeoutMs: number;
  private buildBody: (letter: Letter) => unknown;

  constructor(opts: HttpProviderOptions) {
    if (!opts.url) throw new Error("HttpProvider requires opts.url");
    this.url = opts.url;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.buildBody = opts.buildBody ?? ((letter) => letter);
  }

  async send(letter: Letter): Promise<{ status: "sent" | "failed"; retryable: boolean; detail?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(this.buildBody(letter)),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      return { status: "failed", retryable: true, detail: message };
    } finally {
      clearTimeout(timer);
    }

    const text = (await resp.text().catch(() => "")) || resp.statusText;
    if (resp.ok) return { status: "sent", retryable: false, detail: text.slice(0, 200) };
    const retryable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
    return { status: "failed", retryable, detail: `HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }
}
