import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { catalog } from "../src/catalog";
import { makeDimResolver } from "../src/dims";
import { buildEvents } from "../src/events";
import { baseEnv } from "./helpers";

const cfg = loadConfig(baseEnv);
const row = (id: unknown, secs: number | null, extra: Record<string, unknown> = {}) => ({
  "history.created_time": "2026-11-18 10:00:05", "query.id": id, "query.model": "m", "query.view": "e", "history.source": "dashboard", "history.status": "complete",
  "query.sql": "SELECT * FROM t WHERE email = 'a@b.com' AND n = 99", "query_performance_metrics.async_processing": secs, "query_performance_metrics.execute_main_query": 3,
  "query_performance_metrics.bi_engine_mode": "FULL", "user.name": "Alice", "user.email": "alice@example.com", ...extra,
});
const ev = (rows: Record<string, unknown>[], c = cfg) => buildEvents(rows, makeDimResolver(rows, c, catalog), catalog, c);

describe("buildEvents", () => {
  it("emits only for rows above the threshold (strictly greater)", () => {
    expect(ev([row(1, 30), row(2, 30.1), row(3, 5), row(4, null)]).events.map((e) => e["looker.query.id"])).toEqual(["2"]);
  });
  it("builds the event with shared dims, timings and masked SQL", () => {
    const e = ev([row(2, 45)]).events[0]!;
    expect(e).toMatchObject({
      "event.type": "looker.slow_query", "event.provider": "looker", timestamp: "2026-11-18T10:00:05.000Z",
      "looker.model": "m", "looker.instance": "acme-prod", "gcp.region": "europe-west9", "gcp.project.id": "my-project",
      "looker.timing.async_processing": 45, "looker.timing.execute_main_query": 3, "looker.slow_query.threshold_seconds": 30,
      "db.query.text": "SELECT * FROM t WHERE email = * AND n = *", "looker.sql.masked": true, "looker.bi_engine.mode": "FULL",
    });
  });
  it("never includes user identity or raw SQL", () => {
    const json = JSON.stringify(ev([row(2, 45)]).events);
    expect(json).not.toMatch(/Alice|alice@|a@b\.com|n = 99/);
  });
  it("drops the SQL (fail-closed) when it cannot be masked", () => {
    const e = ev([row(2, 45, { "query.sql": "SELECT 'unterminated" })]).events[0]!;
    expect(e).not.toHaveProperty("db.query.text");
    expect(e["looker.sql.masked"]).toBe(false);
    expect(JSON.stringify(e)).not.toMatch(/unterminated/);
  });
  it("is idempotent: stable event.id per instance+query id, deduped within a batch", () => {
    const a = ev([row(7, 40), row(7, 40)]);
    expect(a.events).toHaveLength(1);
    expect(ev([row(7, 40)]).events[0]!["event.id"]).toBe(a.events[0]!["event.id"]);
    expect(ev([row(8, 40)]).events[0]!["event.id"]).not.toBe(a.events[0]!["event.id"]);
  });
  it("skips rows without a query id", () => {
    const r = ev([row(null, 99)]);
    expect(r.events).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });
  it("honours a configured threshold and field", () => {
    const c = { ...cfg, slowThresholdS: 2, slowField: "execute_main_query" };
    expect(ev([row(1, 1)], c).events).toHaveLength(1);
  });
});
