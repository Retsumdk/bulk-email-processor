import { describe, test, expect } from "bun:test";

import { render, renderTemplate, parse, render as r2 } from "../src/template.ts";
import { parseCsv, tokenizeCsv, rowsToRecipients, dedupe, partition, ctxFor, loadRecipients } from "../src/recipients.ts";
import { Outbox } from "../src/queue.ts";
import { ConsoleProvider, NullProvider, ExplodingProvider } from "../src/providers/index.ts";
import { runBatch, retryDelayMs } from "../src/pipeline.ts";
import * as api from "../src/index.ts";
import type { Letter, Recipient } from "../src/types.ts";

describe("template engine", () => {
  test("interpolates vars and escapes HTML by default", () => {
    expect(render("Hi {{ name }}", { name: "Ada" })).toBe("Hi Ada");
    expect(render("{{ bad }}", { bad: "<b>x</b>" })).toBe("&lt;b&gt;x&lt;/b&gt;");
  });
  test("triple-mustache emits raw", () => {
    expect(render("{{{ raw }}}", { raw: "<b>x</b>" })).toBe("<b>x</b>");
  });
  test("if / else", () => {
    const t = "{{#if ok}}yes{{else}}no{{/if}}";
    expect(render(t, { ok: true })).toBe("yes");
    expect(render(t, { ok: false })).toBe("no");
    expect(render(t, {})).toBe("no");
  });
  test("unless", () => {
    expect(render("{{#unless x}}hidden{{/unless}}", { x: 1 })).toBe("");
    expect(render("{{#unless x}}shown{{/unless}}", { x: 0 })).toBe("shown");
    expect(render("{{#unless x}}missing{{/unless}}", {})).toBe("missing");
  });
  test("each with @index and this", () => {
    const t = "{{#each items}}[{{@index}}={{this}}]{{/each}}";
    expect(render(t, { items: ["a", "b", "c"] })).toBe("[0=a][1=b][2=c]");
  });
  test("nested each/if + dot paths", () => {
    const tpl = "{{#each users}}{{#if active}}{{name}};{{/if}}{{/each}}";
    const out = render(tpl, { users: [ { name: "a", active: true }, { name: "b", active: false }, { name: "c", active: true } ] });
    expect(out).toBe("a;c;");
  });
  test("helpers upper/lower", () => {
    expect(render(`{{upper name}}/{{lower tag}}/{{default missing "x"}}`, { name: "ada", tag: "BIG" })).toBe("ADA/big/x");
  });
  test("renderTemplate pulls subject/text/html from bundle", () => {
    const bundle = { subject: "Hello {{name}}", text: "Hi {{name}}", html: "<p>{{name}}</p>" };
    const out = renderTemplate(bundle, { name: "Ada" });
    expect(out.subject).toBe("Hello Ada");
    expect(out.text).toBe("Hi Ada");
    expect(out.html).toBe("<p>Ada</p>");
  });
  test("parse produces an AST that re-renders identically", () => {
    const src = "Hello {{name}}, {{#if vip}}{{upper name}}{{/if}}";
    const nodes = parse(src);
    expect(r2(src, { name: "z", vip: true })).toBe("Hello z, Z");
    expect(nodes.length).toBeGreaterThan(2);
  });
});

describe("recipients", () => {
  const csv = "email,name,vip\nADA@Example.COM,Ada Lovelace,yes\nalan@example.com,Alan,X\nbadaddress,No at,nope\n";
  test("tokenizeCsv handles quoting + CRLF", () => {
    expect(tokenizeCsv('a,"b,c",d\n1,"x""y",2\r\n')).toEqual([["a","b,c","d"],["1",'x"y',"2"]]);
  });
  test("parseCsv is header-keyed", () => {
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ email: "ADA@Example.COM", name: "Ada Lovelace" });
  });
  test("rowsToRecipients validates + lowercases + collects vars", () => {
    const recs = rowsToRecipients(parseCsv(csv));
    expect(recs).toHaveLength(2); // invalid address dropped
    expect(recs[0]!.email).toBe("ada@example.com");
    expect(recs[0]!.vars).toMatchObject({ vip: "yes" });
    expect(recs[0]!.name).toBe("Ada Lovelace");
  });
  test("dedupe keeps first occurrence by email", () => {
    const a: Recipient = { email: "x@y.com", name: "A" };
    const b: Recipient = { email: "X@y.com", name: "B" };
    expect(dedupe([a, b])).toHaveLength(1);
    expect(dedupe([a, b])[0]!.name).toBe("A");
  });
  test("partition splits suppressed + blocklist", () => {
    const recs: Recipient[] = [ { email: "a@x.com", suppressed: true }, { email: "b@x.com" }, { email: "c@x.com" } ];
    const { sendable, suppressed } = partition(recs, ["B@X.com"]);
    expect(suppressed.map((r) => r.email)).toEqual(["a@x.com", "b@x.com"]);
    expect(sendable.map((r) => r.email)).toEqual(["c@x.com"]);
  });
  test("ctxFor flattens name + vars", () => {
    expect(ctxFor({ email: "a@x.com", name: "N", vars: { team: "core" } })).toMatchObject({ email: "a@x.com", name: "N", team: "core" });
  });
  test("loadRecipients reads a JSON file", async () => {
    const f = "/tmp/bulk-email-test-recs.json";
    await Bun.write(f, JSON.stringify(["a@x.com", { email: "b@x.com", name: "B" }, "bad"]));
    const recs = loadRecipients(f);
    expect(recs).toHaveLength(2);
  });
});

describe("outbox", () => {
  test("FIFO + deferral + ack", () => {
    const q = new Outbox();
    q.add({ id: "1", to: "a", from: "f", subject: "s", attempts: 0, enqueuedAt: 1 });
    q.add({ id: "2", to: "b", from: "f", subject: "s", attempts: 0, enqueuedAt: 2, dueAt: Date.now() + 1000 });
    expect(q.next()!.id).toBe("1");
    q.ack("1");
    expect(q.next()).toBeUndefined(); // 2 is deferred
    expect(q.pendingDueAt()).toBeGreaterThan(Date.now());
  });
  test("requeue increments attempts and defers", () => {
    const q = new Outbox();
    const m = { id: "x", to: "a", from: "f", subject: "s", attempts: 0, enqueuedAt: 0 };
    q.add(m);
    const popped = q.next()!;
    q.requeue(popped, 100);
    expect(q.next()).toBeUndefined();
    expect(q.remaining()).toBe(1);
  });
  test("disk persistence survives a reload", async () => {
    const path = "/tmp/bulk-email-outbox.jsonl";
    const q = new Outbox(path);
    q.add({ id: "p1", to: "a", from: "f", subject: "s", attempts: 0, enqueuedAt: Date.now() });
    const q2 = new Outbox(path);
    expect(q2.remaining()).toBe(1);
    expect(q2.next()!.id).toBe("p1");
  });
});

describe("pipeline + transports", () => {
  const recs: Recipient[] = [
    { email: "a@x.com", name: "Alice", vars: { plan: "pro" } },
    { email: "b@x.com", name: "Bob" },
  ];
  test("runBatch sends every recipient with a null provider", async () => {
    const provider = new NullProvider();
    const report = await runBatch({
      recipients: recs,
      template: { subject: "Hello {{name}} ({{plan}})", text: "Hi {{name}}" },
      provider,
      send: { from: "f@x.com" },
    });
    expect(provider.sends).toBe(2);
    expect(report.sent).toBe(2);
    expect(report.results[0]!.to).toBe("a@x.com");
  });
  test("console provider captures rendered letters", async () => {
    const provider = new ConsoleProvider();
    await runBatch({ recipients: [recs[0]!], template: { subject: "Hi {{name}}", text: "Your plan: {{plan}}" }, provider, send: { from: "f@x.com" } });
    expect(provider.log).toHaveLength(1);
    expect(provider.log[0]!.subject).toBe("Hi Alice");
    expect(provider.log[0]!.text).toBe("Your plan: pro");
  });
  test("exploding provider dead-letters after maxRetries", async () => {
    const provider = new ExplodingProvider();
    const report = await runBatch({
      recipients: [{ email: "a@x.com" }],
      template: { subject: "s", text: "t" },
      provider,
      send: { from: "f@x.com", maxRetries: 1, backoffMs: 0 },
    });
    expect(report.failed).toBe(1);
    expect(report.deadLettered).toBe(1);
    expect(provider.calls).toBe(2); // initial + 1 retry = attempts 2, max attempts = maxRetries+1
  });
  test("retryable failures are deferred then retried", async () => {
    const provider = { id: "flaky", sends: 0, send: async (l: Letter) => { provider.sends++; return provider.sends === 1 ? { status: "failed" as const, retryable: true, detail: "rl" } : { status: "sent" as const, retryable: false }; } };
    const report = await runBatch({
      recipients: [{ email: "a@x.com" }],
      template: { subject: "s" },
      provider,
      send: { from: "f@x.com", maxRetries: 2, backoffMs: 0 },
    });
    expect(provider.sends).toBe(2);
    expect(report.sent).toBe(1);
  });
  test("retryDelayMs doubles the base per attempt", () => {
    expect(retryDelayMs(1000, 1)).toBe(1000);   // first retry: no delay
    expect(retryDelayMs(1000, 2)).toBe(2000);   // second: base x2
    expect(retryDelayMs(1000, 3)).toBe(4000);   // third: base x4
    expect(retryDelayMs(100, 4)).toBe(800);     // fourth: base x8
    expect(retryDelayMs(1000, 100)).toBe(7 * 24 * 60 * 60 * 1000); // clamped to ~7 days
  });
});

describe("public API surface", () => {
  test("exports the documented entry points", () => {
    for (const k of ["Outbox", "runBatch", "renderTemplate", "ConsoleProvider", "HttpProvider", "parseCsv", "loadRecipients", "partition"]) {
      expect((api as Record<string, unknown>)[k]).toBeDefined();
    }
  });
});
