/**
 * Zero-dependency mail template engine.
 *
 * A real recursive-descent parser that builds an AST, so nested `each` / `if`
 * blocks work. Supports:
 *   {{ variable }}                interpolation (HTML-escaped)
 *   {{{ variable }}}              raw interpolation (no escaping)
 *   {{#if var}} ... {{else}} ... {{/if}}
 *   {{#unless var}} ... {{/unless}}
 *   {{#each items}} {{@index}} {{this}} ... {{/each}}
 *   {{upper "x"}} / {{lower "x"}} / {{default var "fallback"}}  helpers
 *
 * Automatic HTML escaping means hostile `{{name}}` data cannot smuggle markup
 * into an HTML template.
 */
import type { TemplateBundle } from "./types.ts";

type Node =
  | { t: "text"; s: string }
  | { t: "output"; raw: boolean; expr: string }
  | { t: "if"; test: string; yes: Node[]; no: Node[] }
  | { t: "unless"; test: string; body: Node[] }
  | { t: "each"; list: string; body: Node[]; alias: string };

const TOKEN = /\{\{(\{?[^{}]*\}?)\}\}/;

/** Parse a template string into an AST node array. */
export function parse(src: string): Node[] {
  interface Frame {
    nodes: Node[];
    open?: Node;
  }
  const stack: Frame[] = [{ nodes: [] }];
  const top = (): Frame => stack[stack.length - 1]!;
  let rest = src;

  while (rest.length > 0) {
    const m = TOKEN.exec(rest);
    if (!m) {
      top().nodes.push({ t: "text", s: rest });
      break;
    }
    const before = rest.slice(0, m.index);
    if (before) top().nodes.push({ t: "text", s: before });
    const rawTag = m[1] ?? "";
    rest = rest.slice(m.index + m[0].length);

    const tag = rawTag.trim();
    if (tag.startsWith("!")) continue; // comment

    const open = /^#if\s+(.+)$/.exec(tag);
    const unless = /^#unless\s+(.+)$/.exec(tag);
    const each = /^#each\s+(.+?)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(tag);

    if (each) {
      const node: Node = { t: "each", list: each[1]!.trim(), body: [], alias: each[2] ?? "this" };
      top().nodes.push(node);
      stack.push({ nodes: node.body });
      continue;
    }
    if (unless) {
      const node: Node = { t: "unless", test: unless[1]!.trim(), body: [] };
      top().nodes.push(node);
      stack.push({ nodes: node.body });
      continue;
    }
    if (open) {
      const node: Node = { t: "if", test: open[1]!.trim(), yes: [], no: [] };
      top().nodes.push(node);
      stack.push({ nodes: node.yes, open: node });
      continue;
    }
    if (tag.startsWith("else")) {
      const frame = top();
      if (!frame.open || frame.open.t !== "if") throw new Error("{{else}} outside {{#if}}");
      const fresh: Node[] = [];
      frame.open.no = fresh;
      frame.nodes = fresh;
      continue;
    }
    if (tag.startsWith("/")) {
      if (stack.length <= 1) throw new Error(`Unexpected closing tag '${tag}'`);
      stack.pop();
      continue;
    }
    const raw = /^\{([\s\S]+)\}$/.exec(tag);
    if (raw) {
      top().nodes.push({ t: "output", raw: true, expr: raw[1]!.trim() });
      continue;
    }
    top().nodes.push({ t: "output", raw: false, expr: tag });
  }
  if (stack.length !== 1) throw new Error(`Unclosed block tag (${stack.length - 1} open)`);
  return stack[0]!.nodes;
}

/** Render an AST against a context. */
export function render(src: string, ctx: Record<string, unknown>): string {
  return renderNodes(parse(src), ctx, 0);
}

function renderNodes(nodes: Node[], ctx: Record<string, unknown>, depth: number): string {
  if (depth > 128) throw new Error("Template recursion too deep");
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.s;
    else if (n.t === "output") {
      const v = evalExpr(n.expr, ctx);
      out += v === null || v === undefined ? "" : n.raw ? String(v) : escapeHtml(v);
    } else if (n.t === "if") {
      out += truthy(evalExpr(n.test, ctx)) ? renderNodes(n.yes, ctx, depth + 1) : renderNodes(n.no, ctx, depth + 1);
    } else if (n.t === "unless") {
      if (!truthy(evalExpr(n.test, ctx))) out += renderNodes(n.body, ctx, depth + 1);
    } else if (n.t === "each") {
      const list = evalExpr(n.list, ctx);
      if (Array.isArray(list)) {
        list.forEach((item, idx) => {
          // Handlebars `#each` semantics: bare names resolve against the item's
          // own fields (this.active), and `this` / the alias point at the item.
          const flat =
            typeof item === "object" && item !== null && !Array.isArray(item)
              ? (item as Record<string, unknown>)
              : {};
          const scoped = { ...ctx, ...flat, this: item, [n.alias]: item, "@index": idx };
          out += renderNodes(n.body, scoped, depth + 1);
        });
      }
    }
  }
  return out;
}

function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, ctx);
}

function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (typeof v === "number") return v !== 0;
  return true;
}

function isQuoted(v: string): string | null {
  if (v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return null;
}

/** Evaluate a single expression/helper call against a context. */
function evalExpr(expr: string, ctx: Record<string, unknown>): unknown {
  const e = expr.trim();
  if (isQuoted(e)) return e.slice(1, -1);
  const fn = /^([A-Za-z_]\w*)\s+([\s\S]+)$/.exec(e);
  if (fn) {
    const vals = splitArgs(fn[2]!).map((a) => {
      const q = isQuoted(a.trim());
      return q !== null ? q : evalExpr(a.trim(), ctx);
    });
    switch (fn[1]) {
      case "upper":
        return String(vals[0] ?? "").toUpperCase();
      case "lower":
        return String(vals[0] ?? "").toLowerCase();
      case "default":
        return vals[0] === undefined || vals[0] === null || vals[0] === "" ? vals[1] : vals[0];
      default:
        return undefined;
    }
  }
  return resolvePath(ctx, e);
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      cur += c;
      if (c === '"' && s[i - 1] !== "\\") quoted = false;
    } else if (c === '"') {
      quoted = true;
      cur += c;
    } else if (c === "(" || c === "[") {
      depth++;
      cur += c;
    } else if (c === ")" || c === "]") {
      depth--;
      cur += c;
    } else if (c === " " && depth === 0 && !quoted) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render a full TemplateBundle (subject + text + html). */
export function renderTemplate(tpl: TemplateBundle, ctx: Record<string, unknown>): {
  subject: string;
  text: string;
  html: string;
} {
  return {
    subject: render(tpl.subject, ctx),
    text: tpl.text ? render(tpl.text, ctx) : "",
    html: tpl.html ? render(tpl.html, ctx) : "",
  };
}
