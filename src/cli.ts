#!/usr/bin/env bun
/**
 * bulk-email-processor — command-line interface.
 *
 *   bun src/cli.ts send  --template <file> --recipients <csv> --from <addr>
 *                        [--provider console|http] [--subject <inline>]
 *                        [--text <text-file>] [--html <html-file>]
 *                        [--rate <n>] [--max-retries <n>] [--sink <file>]
 *                        [--http-url <url>] [--http-token <env|value>]
 *
 * Subcommands: send | validate | help
 */
import { readFileSync } from "node:fs";
import { ConsoleProvider, HttpProvider } from "./providers/index.ts";
import { loadRecipients, partition, dedupe } from "./recipients.ts";
import { runBatch } from "./pipeline.ts";
import type { Recipient, TemplateBundle } from "./types.ts";

interface Parsed {
  command: string;
  flags: Record<string, string>;
  positionals: string[];
}

function parseArgs(argv: string[]): Parsed {
  const p: Parsed = { command: "send", flags: {}, positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--" ) { p.positionals.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) { p.flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { p.flags[a.slice(2)] = next; i++; }
      else p.flags[a.slice(2)] = "true";
    } else if (a.startsWith("-")) {
      p.flags[a.replace(/^-+/, "")] = "true";
    } else {
      if (!isSubcommand(a)) p.positionals.push(a);
    }
  }
  const sub = argv.find((a) => isSubcommand(a));
  if (sub) p.command = sub;
  return p;
}

function isSubcommand(a: string): boolean {
  return a === "send" || a === "validate" || a === "help";
}

async function main(): Promise<number> {
  const p = parseArgs(process.argv.slice(2));
  if (p.command === "help" || p.flags.help || p.flags.h) { printHelp(); return 0; }
  const f: Record<string, string> = p.flags;

  if (p.command === "validate") {
    const path = f.recipients ?? f.input ?? p.positionals[0];
    if (!path) { console.error("validate: pass --recipients <file>"); return 2; }
    const recs = loadRecipients(path);
    const deduped = dedupe(recs);
    const dropped = recs.length - deduped.length;
    const { sendable, suppressed } = partition(deduped);
    console.log(`OK ${path}: ${sendable.length} sendable, ${suppressed.length} suppressed, ${dropped} dropped/duplicate`);
    return 0;
  }

  if (p.command !== "send") {
    console.error(`Unknown command: ${p.command}`); printHelp(); return 2;
  }

  // --- Template ---
  const template: TemplateBundle = { subject: "" };
  if (f.subject) {
    template.subject = f.subject;
  } else if (f["subject-var"]) {
    template.subject = `{{ ${f["subject-var"]} }}`;
  } else if (f.template) {
    const src = readFileSync(f.template, "utf-8");
    const m = /^\s*Subject:\s*(.+)$/m.exec(src);
    if (m) template.subject = m[1]!;
    const tm = /^\s*Body:\s*([\s\S]*)$/m.exec(src);
    if (tm) template.text = tm[1]!;
  }
  if (f.text) template.text = readFileSync(f.text, "utf-8");
  if (f.html) template.html = readFileSync(f.html, "utf-8");
  if (!template.subject && !template.text && !template.html) {
    console.error("No template provided. Use --subject, --text/--html, or --template <file>.");
    return 2;
  }

  // --- Recipients ---
  const recPath = f.recipients ?? f.input ?? p.positionals[0];
  if (!recPath) { console.error("send: pass --recipients <file>"); return 2; }
  let recs: Recipient[] = dedupe(loadRecipients(recPath));
  // Optional extra column-based suppression via --suppress comma list
  const suppressList = f.suppress ? f.suppress.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const { sendable, suppressed } = partition(recs, suppressList);

  // --- Provider ---
  const providerName = f.provider ?? "console";
  const provider = providerName === "http"
    ? new HttpProvider({ url: requireHttpUrl(f), token: f["http-token"] })
    : new ConsoleProvider({ sink: f.sink });

  // --- Send ---
  const report = await runBatch({
    recipients: sendable,
    template,
    suppressedCount: suppressed.length,
    provider,
    send: {
      from: f.from ?? "noreply@example.com",
      ratePerSecond: f.rate ? Number(f.rate) : undefined,
      maxRetries: f["max-retries"] ? Number(f["max-retries"]) : 3,
      backoffMs: f["backoff-ms"] ? Number(f["backoff-ms"]) : 1000,
      timeoutMs: f["timeout-ms"] ? Number(f["timeout-ms"]) : 30_000,
    },
  });

  console.log(`Run ${report.runId}`);
  console.log(`Scheduled ${report.totalScheduled} | suppressed ${report.suppressed} | attempted ${report.attempted}`);
  console.log(`Sent ${report.sent} | failed ${report.failed} | deferred ${report.deferred} | dead-lettered ${report.deadLettered}`);
  const rps = Number.isFinite(report.ratePerSecond) ? `${report.ratePerSecond}/s` : "unlimited";
  console.log(`Rate ${rps} | elapsed ${report.finishedAt}`);
  return report.failed || report.deadLettered ? 1 : 0;
}

function requireHttpUrl(f: Record<string, string>): string {
  if (f["http-url"]) return f["http-url"];
  const env = process.env.HTTP_MAIL_URL;
  if (env) return env;
  throw new Error("http provider requires --http-url or HTTP_MAIL_URL env");
}

function printHelp(): void {
  const txt = `bulk-email-processor — queue-based bulk email w/ templates

USAGE
  bun src/cli.ts send --template <file> --recipients <file> [options]
  bun src/cli.ts validate --recipients <file>
  bun src/cli.ts help

TEMPLATE
  --template <file>      text file with a "Subject:" line then a body
  --subject <inline>     inline subject with {{vars}}
  --subject-var <name>   use a recipient var as the subject, e.g. name
  --text <file>          plain-text body file
  --html <file>          HTML body file

RECIPIENTS
  --recipients <file>    CSV (email,name,var...) or JSON array
  --suppress <list>      comma-separated extra suppressed emails

PROVIDER
  --provider console|http   (default console — dry run / log only)
  --sink <file>             append rendered JSONL messages for console
  --http-url <url>          REST email API base URL (or HTTP_MAIL_URL)
  --http-token <token>      bearer token (or HTTP_MAIL_TOKEN env)

RATE & RETRY
  --rate <n>            max sends per second (0 = unlimited)
  --max-retries <n>     retries before dead-letter (default 3)
  --backoff-ms <n>      base backoff, doubled each retry (default 1000)

MISC
  --from <addr>         From address (default noreply@example.com)
`;
  process.stdout.write(txt);
}

main().then((code) => process.exit(code)).catch((err) => { console.error(err); process.exit(1); });
