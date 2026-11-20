import { createHash } from "crypto";
import { type Catalog, allGroups, metricField, metricsOf } from "./catalog";
import type { Config } from "./config";
import type { Row } from "./dims";
import { maskSql } from "./mask";
import { cleanValue, parseUtc, toNumber } from "./util";

export type DtEvent = Record<string, unknown>;

/** One event per slow query. Allow-listed fields only: no user name/email, SQL always masked (fail-closed). */
export function buildEvents(rows: Row[], resolve: (r: Row) => Record<string, string>, catalog: Catalog, cfg: Config) {
  const events = new Map<string, DtEvent>();
  const timings = metricsOf(catalog, allGroups(catalog));
  let dropped = 0;
  for (const row of rows) {
    const secs = toNumber(row[metricField(catalog, cfg.slowField)]);
    if (!(secs > cfg.slowThresholdS)) continue;
    const qid = row[catalog.queryId];
    const t = parseUtc(row[catalog.time]);
    if (qid == null || qid === "" || Number.isNaN(t)) { dropped++; continue; }
    const id = createHash("sha256").update(`${cfg.lookerInstance}|${qid}`).digest("hex").slice(0, 32);
    if (events.has(id)) continue;
    const ev: DtEvent = {
      "event.id": id, "event.type": catalog.event.type, "event.provider": catalog.event.provider, "event.name": catalog.event.name,
      timestamp: new Date(t).toISOString(), "looker.query.id": String(qid),
      "looker.slow_query.field": cfg.slowField, "looker.slow_query.threshold_seconds": cfg.slowThresholdS,
      ...resolve(row),
    };
    for (const m of timings) { const v = toNumber(row[m.field]); if (Number.isFinite(v)) ev[`looker.timing.${m.id}`] = v; }
    const mode = row[catalog.biEngineMode];
    if (typeof mode === "string" && mode) ev["looker.bi_engine.mode"] = cleanValue(mode);
    const raw = row[catalog.sql];
    if (typeof raw === "string" && raw) {
      const masked = maskSql(raw);
      ev["looker.sql.masked"] = masked !== null;
      if (masked !== null) ev["db.query.text"] = masked;
    }
    events.set(id, ev);
  }
  return { events: [...events.values()], dropped };
}
