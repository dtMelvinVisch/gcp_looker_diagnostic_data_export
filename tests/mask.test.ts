import { describe, expect, it } from "vitest";
import { maskSql } from "../src/mask";

const m = (s: string) => maskSql(s);

describe("maskSql", () => {
  it("masks strings and numbers", () => {
    expect(m("SELECT a FROM t WHERE name = 'Alice' AND age > 42")).toBe("SELECT a FROM t WHERE name = * AND age > *");
  });
  it("keeps identifiers that contain digits", () => {
    expect(m("SELECT t1.col_2 FROM t1 WHERE x = 7")).toBe("SELECT t1.col_2 FROM t1 WHERE x = *");
  });
  it("handles escaped quotes ('' and backslash)", () => {
    expect(m("WHERE a = 'O''Brien' AND b = 'it\\'s'")).toBe("WHERE a = * AND b = *");
  });
  it("collapses IN lists", () => {
    expect(m("WHERE id IN (1, 2, 3) AND s IN ('a','b')")).toBe("WHERE id IN (*) AND s IN (*)");
  });
  it("masks typed date/time literals and intervals", () => {
    expect(m("WHERE d >= DATE '2024-01-31' AND t < TIMESTAMP '2024-01-31 10:00:00' + INTERVAL 5 DAY"))
      .toBe("WHERE d >= DATE * AND t < TIMESTAMP * + INTERVAL * DAY");
  });
  it("masks decimals, negatives, exponents and hex", () => {
    expect(m("x = 3.14 OR y = -2 OR z = 1e-5 OR h = 0xFF OR w = .5")).toBe("x = * OR y = -* OR z = * OR h = * OR w = *");
  });
  it("masks parameters and placeholders", () => {
    expect(m("a = ? AND b = $1 AND c = :name AND d = @p AND e = %s AND f = {{ x }}"))
      .toBe("a = * AND b = * AND c = * AND d = * AND e = * AND f = *");
  });
  it("keeps :: casts", () => {
    expect(m("SELECT x::int FROM t")).toBe("SELECT x::int FROM t");
  });
  it("strips comments (they can contain data)", () => {
    const out = m("SELECT 1 -- user bob@example.com\n/* secret 'x' */ FROM t");
    expect(out).not.toMatch(/bob|secret/);
    expect(out).toContain("FROM t");
  });
  it("masks double-quoted tokens (may be string literals)", () => {
    expect(m('WHERE a = "secret value"')).toBe("WHERE a = *");
  });
  it("keeps backtick identifiers", () => {
    expect(m("SELECT `proj.ds.tbl`.`c` FROM `proj.ds.tbl` WHERE `c` = 'v'")).toBe("SELECT `proj.ds.tbl`.`c` FROM `proj.ds.tbl` WHERE `c` = *");
  });
  it("masks triple-quoted and dollar-quoted strings", () => {
    expect(m("a = '''multi\nline''' AND b = $$x'y$$ AND c = $tag$z$tag$")).toBe("a = * AND b = * AND c = *");
  });
  it("masks LIKE patterns and prefixed strings", () => {
    expect(m("a LIKE '%foo%' AND b = N'x' AND c = E'y'")).toBe("a LIKE * AND b = N* AND c = E*");
  });
  it("fails closed on unterminated string", () => {
    expect(m("SELECT 'oops FROM t")).toBeNull();
  });
  it("fails closed on unterminated comment or NUL", () => {
    expect(m("SELECT 1 /* open")).toBeNull();
    expect(m("SELECT \u0000 1")).toBeNull();
  });
  it("fails closed on non-string input and returns empty for empty", () => {
    expect(maskSql(undefined as unknown as string)).toBeNull();
    expect(m("")).toBe("");
  });
  it("never leaves quotes or digit literals in output for tricky input", () => {
    const out = m("SELECT 'a' || \"b\" || 'c''d' FROM t WHERE x = 1234567890 AND y IN (1,2)")!;
    expect(out).not.toMatch(/['"]|\d{3}/);
  });
  it("masks digit-led tokens and underscore numerics entirely", () => {
    expect(m("a = 1_000_000 AND b = 12abc")).toBe("a = * AND b = *");
  });
  it("fails closed on oversized input", () => {
    expect(m("a".repeat(300_000))).toBeNull();
  });
  it("truncates very long output", () => {
    expect(m("SELECT " + "a, ".repeat(10000) + "b")!.length).toBeLessThanOrEqual(8200);
  });
});
