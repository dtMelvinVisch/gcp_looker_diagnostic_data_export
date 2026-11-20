const MAX_OUT = 8000;
const MAX_IN = 200_000;
const isId = (c: string) => /[A-Za-z0-9_$]/.test(c);
const NUMBER = /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;

/**
 * Replace every literal and parameter in a SQL text with `*`.
 * Fail closed: returns null if the text cannot be scanned safely (caller must then drop the SQL).
 * Double-quoted tokens are masked too, since several dialects use them for string literals.
 */
export function maskSql(sql: string): string | null {
  if (typeof sql !== "string" || sql.length > MAX_IN || sql.includes("\u0000")) return null;
  const n = sql.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const nx = sql[i + 1] ?? "";
    const prev = i > 0 ? sql[i - 1]! : "";
    if (c === "-" && nx === "-") { const e = sql.indexOf("\n", i); out += " "; i = e < 0 ? n : e; continue; }
    if (c === "/" && nx === "*") { const e = sql.indexOf("*/", i + 2); if (e < 0) return null; out += " "; i = e + 2; continue; }
    if ((c === "'" || c === '"') && sql.startsWith(c.repeat(3), i)) {
      const e = sql.indexOf(c.repeat(3), i + 3); if (e < 0) return null; out += "*"; i = e + 3; continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1; let closed = false;
      while (j < n) {
        const d = sql[j]!;
        if (d === "\\") { j += 2; continue; }
        if (d === c) { if (sql[j + 1] === c) { j += 2; continue; } closed = true; break; }
        j++;
      }
      if (!closed) return null;
      out += "*"; i = j + 1; continue;
    }
    if (c === "`") { const e = sql.indexOf("`", i + 1); if (e < 0) return null; out += sql.slice(i, e + 1); i = e + 1; continue; }
    if (c === "$") {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) { const e = sql.indexOf(tag, i + tag.length); if (e < 0) return null; out += "*"; i = e + tag.length; continue; }
      const p = /^\$\d+/.exec(sql.slice(i, i + 12))?.[0];
      if (p) { out += "*"; i += p.length; continue; }
    }
    if (c === "{" && nx === "{") { const e = sql.indexOf("}}", i + 2); if (e < 0) return null; out += "*"; i = e + 2; continue; }
    if (c === "?") { out += "*"; i++; continue; }
    if (c === "%" && (nx === "s" || nx === "d")) { out += "*"; i += 2; continue; }
    if (c === ":" && nx === ":") { out += "::"; i += 2; continue; }
    if ((c === ":" && !isId(prev) && isId(nx)) || c === "@") {
      let j = i + 1; while (j < n && (isId(sql[j]!) || sql[j] === "@")) j++;
      out += "*"; i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) { let j = i + 1; while (j < n && isId(sql[j]!)) j++; out += sql.slice(i, j); i = j; continue; }
    if (/\d/.test(c) || (c === "." && /\d/.test(nx) && !isId(prev))) {
      const m = NUMBER.exec(sql.slice(i, i + 64))?.[0];
      if (m) { let j = i + m.length; while (j < n && isId(sql[j]!)) j++; out += "*"; i = j; continue; }
    }
    out += c; i++;
  }
  out = out.replace(/\(\s*\*(?:\s*,\s*\*)+\s*\)/g, "(*)");
  if (/['"]/.test(out)) return null; // invariant: no quote may survive masking
  return out.length > MAX_OUT ? out.slice(0, MAX_OUT) + " ..." : out;
}
