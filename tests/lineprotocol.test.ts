import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { catalog } from "../src/catalog";
import { makeDimResolver } from "../src/dims";
import { aggregate } from "../src/aggregate";
import { buildPayloads } from "../src/lineprotocol";
import { baseEnv } from "./helpers";

const cfg = loadConfig(baseEnv);
const row = (t: string, v: number | null, extra: Record<string, unknown> = {}) => ({
  "history.created_time": t, "query.id": 1, "query.model": "m", "query.view": "e", "history.source": "dashboard", "history.status": "complete",
  "query_performance_metrics.async_processing": v, "query_performance_metrics.connection_held": 1, ...extra,
});

describe("aggregate", () => {
  it("aggregates min/max/sum/count per minute and dims, skipping nulls", () => {
    const rows = [row("2026-11-18 10:00:05", 2), row("2026-11-18 10:00:50", 4), row("2026-11-18 10:00:51", null), row("2026-11-18 10:01:00", 9)];
    const { points } = aggregate(rows, makeDimResolver(rows, cfg, catalog), catalog, ["overall"]);
    const p = points.find((x) => x.key.endsWith("overall.async_processing.duration") && x.minute === Date.UTC(2026, 10, 18, 10, 0))!;
    expect(p).toMatchObject({ min: 2, max: 4, sum: 6, count: 2 });
    expect(points.filter((x) => x.key.endsWith("async_processing.duration"))).toHaveLength(2);
  });
  it("never uses query id or sql as a dimension and carries constants", () => {
    const rows = [row("2026-11-18 10:00:05", 2, { "query.sql": "select 1" })];
    const { points } = aggregate(rows, makeDimResolver(rows, cfg, catalog), catalog, ["overall"]);
    const dims = Object.keys(points[0]!.dims).sort();
    expect(dims).toEqual(["gcp.project.id", "gcp.region", "looker.explore", "looker.instance", "looker.model", "looker.source", "looker.status"]);
    expect(JSON.stringify(points)).not.toMatch(/select 1/);
  });
  it("skips invalid times, negative and non-numeric values", () => {
    const rows = [row("garbage", 2), row("2026-11-18 10:00:00", -1), row("2026-11-18 10:00:00", "x" as never)];
    const r = aggregate(rows, makeDimResolver(rows, cfg, catalog), catalog, ["overall"]);
    expect(r.skipped).toBe(1);
    expect(r.points.filter((p) => p.key.endsWith("async_processing.duration"))).toHaveLength(0);
  });
  it("caps dimension cardinality with an 'other' bucket", () => {
    const small = { ...cfg, maxDimValues: 2 };
    const rows = ["a", "a", "a", "b", "b", "c", "d"].map((s, i) => row("2026-11-18 10:00:00", 1, { "history.source": s, "query.id": i }));
    const vals = new Set(rows.map((r) => makeDimResolver(rows, small, catalog)(r)["looker.source"]));
    expect([...vals].sort()).toEqual(["a", "b", "other"]);
  });
  it("collapses dimensions when the combined series cap is exceeded", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row("2026-11-18 10:00:00", 1, { "query.view": `e${i}`, "history.source": `s${i % 3}`, "query.id": i }));
    const r = makeDimResolver(rows, { ...cfg, maxSeries: 5 }, catalog)(rows[0]!);
    expect(r["looker.model"]).toBe("m");
    expect(r["looker.status"]).toBe("all");
    expect(new Set(rows.map((x) => JSON.stringify(makeDimResolver(rows, { ...cfg, maxSeries: 5 }, catalog)(x)))).size).toBeLessThanOrEqual(5);
  });
  it("sanitises dimension values", () => {
    const rows = [row("2026-11-18 10:00:00", 1, { "history.source": "x\n\"y\"".padEnd(300, "z") })];
    const v = makeDimResolver(rows, cfg, catalog)(rows[0]!)["looker.source"]!;
    expect(v.length).toBeLessThanOrEqual(100);
    expect(v).not.toMatch(/\n/);
  });
});

describe("buildPayloads", () => {
  const rows = [row("2026-11-18 10:00:05", 2.5)];
  const { points } = aggregate(rows, makeDimResolver(rows, cfg, catalog), catalog, ["overall"]);
  it("builds gauge lines with ms timestamps, escaped dims, and metadata", () => {
    const { payloads, lines } = buildPayloads(points, catalog, { maxLines: 500, maxBytes: 200_000 });
    const text = payloads[0]!;
    expect(lines).toBe(points.length);
    expect(text).toContain('custom.gcp.looker.overall.async_processing.duration,');
    expect(text).toContain('looker.model="m"');
    expect(text).toMatch(/gauge,min=2.5,max=2.5,sum=2.5,count=1 1794996000000\n/);
    expect(text).toContain('#custom.gcp.looker.overall.async_processing.duration gauge dt.meta.displayname=');
    expect(text).toContain('dt.meta.unit="Second"');
    expect(text).toContain('dt.meta.description="The time the async worker spent processing a query."');
  });
  it("escapes quotes and backslashes in dimension values", () => {
    const r = [row("2026-11-18 10:00:05", 1, { "history.source": 'a"b\\c' })];
    const pts = aggregate(r, makeDimResolver(r, cfg, catalog), catalog, ["overall"]).points;
    expect(buildPayloads(pts, catalog, { maxLines: 500, maxBytes: 200_000 }).payloads[0]).toContain('looker.source="a\\"b\\\\c"');
  });
  it("splits by line and byte limits, repeating metadata per payload", () => {
    const many = Array.from({ length: 6 }, (_, i) => row(`2026-11-18 10:0${i}:00`, 1));
    const pts = aggregate(many, makeDimResolver(many, cfg, catalog), catalog, ["overall"]).points; // 12 points
    const { payloads } = buildPayloads(pts, catalog, { maxLines: 8, maxBytes: 200_000 });
    expect(payloads.length).toBeGreaterThan(1);
    for (const p of payloads) { expect(p.split("\n").filter(Boolean).length).toBeLessThanOrEqual(8); expect(p).toContain("#custom"); }
    const small = buildPayloads(pts, catalog, { maxLines: 500, maxBytes: 1200 });
    expect(small.payloads.length).toBeGreaterThan(1);
    for (const p of small.payloads) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(1200);
  });
});
