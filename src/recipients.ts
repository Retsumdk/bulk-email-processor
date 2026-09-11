/**
 * Recipient loading and normalization.
 *
 * Parses RFC-4180-style CSV (quoted fields, embedded commas/newlines/escaped
 * quotes), primary keyed on a header row, then normalizes into `Recipient[]`
 * with validation, de-duplication, and suppression filtering.
 */
import { existsSync, readFileSync } from "node:fs";
import type { Recipient } from "./types.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lightweight CSV tokenizer → rows of unquoted field strings. */
export function tokenizeCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < csv.length) {
    const c = csv[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** Parse CSV text into header-keyed row objects. */
export function parseCsv(csv: string): Record<string, string>[] {
  const tokens = tokenizeCsv(csv);
  if (tokens.length === 0) return [];
  const header = tokens[0]!.map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (const row of tokens.slice(1)) {
    const obj: Record<string, string> = {};
    row.forEach((val, idx) => {
      const key = header[idx] ?? `col${idx}`;
      obj[key] = val.trim();
    });
    out.push(obj);
  }
  return out;
}

/** Convert parsed CSV rows into validated Recipient objects. */
export function rowsToRecipients(rows: Record<string, string>[]): Recipient[] {
  const out: Recipient[] = [];
  for (const row of rows) {
    const email = (row.email ?? row.Email ?? row.address ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) continue; // drop invalid addresses
    const vars: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (["email", "Email", "address", "name", "Name", "suppressed", "+suppress"].includes(k)) continue;
      const vv = v.trim();
      if (vv !== "") vars[k] = vv;
    }
    const sup = (row["+suppress"] ?? row.suppressed ?? "").trim().toLowerCase();
    out.push({
      email,
      name: (row.name ?? row.Name ?? "").trim() || undefined,
      vars: Object.keys(vars).length ? vars : undefined,
      suppressed: sup === "yes" || sup === "true" || sup === "1",
    });
  }
  return out;
}

/** Read a file and produce Recipient[] (CSV by default, or JSON array). */
export function loadRecipients(path: string): Recipient[] {
  if (!existsSync(path)) throw new Error(`Recipients file not found: ${path}`);
  const raw = readFileSync(path, "utf-8");
  if (path.endsWith(".json")) {
    const parsed = JSON.parse(raw) as Array<Record<string, unknown> | string>;
    return parsed
      .map((e): Recipient | null => {
        if (typeof e === "string") return EMAIL_RE.test(e) ? { email: e.toLowerCase() } : null;
        const emailStr = String(e.email ?? e.Email ?? "").trim().toLowerCase();
        if (!EMAIL_RE.test(emailStr)) return null;
        return { email: emailStr, name: e.name ? String(e.name) : undefined, vars: { ...(e.vars as Record<string, unknown> | undefined) } };
      })
      .filter((r): r is Recipient => r !== null);
  }
  return rowsToRecipients(parseCsv(raw));
}

/** De-duplicate by lower-cased email, keeping the first occurrence. */
export function dedupe(recipients: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of recipients) {
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Build a `{{ }}` context for a given recipient. */
export function ctxFor(r: Recipient): Record<string, unknown> {
  return { email: r.email, name: r.name ?? "", ...(r.vars ?? {}) };
}

/** Partition into sendable vs. suppressed using an optional extra blocklist. */
export function partition(
  recipients: Recipient[],
  extraSuppressed: string[] = [],
): { sendable: Recipient[]; suppressed: Recipient[] } {
  const block = new Set(extraSuppressed.map((e) => e.toLowerCase()));
  const sendable: Recipient[] = [];
  const suppressed: Recipient[] = [];
  for (const r of recipients) {
    if (r.suppressed || block.has(r.email.toLowerCase())) suppressed.push(r);
    else sendable.push(r);
  }
  return { sendable, suppressed };
}
