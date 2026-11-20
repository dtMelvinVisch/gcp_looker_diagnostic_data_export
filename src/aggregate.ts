import { type Catalog, metricsOf } from "./catalog";
import type { Row } from "./dims";
import { parseUtc, toNumber } from "./util";

export interface Point { key: string; minute: number; dims: Record<string, string>; min: number; max: number; sum: number; count: number }

/** One gauge point (min/max/sum/count) per minute, bounded dimension set and metric. Null and negative values are ignored. */
export function aggregate(rows: Row[], resolve: (r: Row) => Record<string, string>, catalog: Catalog, groups: string[]) {
  const metrics = metricsOf(catalog, groups);
  const acc = new Map<string, Point>();
  let skipped = 0;
  for (const row of rows) {
    const t = parseUtc(row[catalog.time]);
    if (Number.isNaN(t)) { skipped++; continue; }
    const minute = Math.floor(t / 60_000) * 60_000;
    const dims = resolve(row);
    const dimKey = JSON.stringify(Object.entries(dims).sort());
    for (const m of metrics) {
      const v = toNumber(row[m.field]);
      if (!Number.isFinite(v) || v < 0) continue;
      const id = `${minute}|${m.key}|${dimKey}`;
      const p = acc.get(id);
      if (p) { p.min = Math.min(p.min, v); p.max = Math.max(p.max, v); p.sum += v; p.count++; }
      else acc.set(id, { key: m.key, minute, dims, min: v, max: v, sum: v, count: 1 });
    }
  }
  const points = [...acc.values()].sort((a, b) => a.minute - b.minute || a.key.localeCompare(b.key));
  return { points, skipped };
}
