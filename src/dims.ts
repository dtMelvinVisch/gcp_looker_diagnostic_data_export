import type { Catalog } from "./catalog";
import type { Config } from "./config";
import { cleanValue } from "./util";

export type Row = Record<string, unknown>;

export const constantDims = (cfg: Config): Record<string, string> => ({
  "looker.instance": cleanValue(cfg.lookerInstance), "gcp.project.id": cleanValue(cfg.project), "gcp.region": cleanValue(cfg.region),
});

/** Bounded dimensions: per dimension only the top-N values of this window survive, the rest become "other". */
export function makeDimResolver(rows: Row[], cfg: Config, catalog: Catalog): (row: Row) => Record<string, string> {
  const keep = catalog.dimensions.map((d) => {
    const counts = new Map<string, number>();
    for (const r of rows) { const v = cleanValue(r[d.field]); counts.set(v, (counts.get(v) ?? 0) + 1); }
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, cfg.maxDimValues).map(([v]) => v);
    return { d, top: new Set(top) };
  });
  const constants = constantDims(cfg);
  const value = ({ d, top }: (typeof keep)[number], row: Row) => { const v = cleanValue(row[d.field]); return top.has(v) ? v : "other"; };
  // Combined cap: while the number of distinct dimension combinations exceeds maxSeries, collapse the last dimension to "all".
  let active = keep.length;
  while (active > 0 && new Set(rows.map((r) => keep.slice(0, active).map((k) => value(k, r)).join("\u0000"))).size > cfg.maxSeries) active--;
  return (row) => {
    const dims = { ...constants };
    keep.forEach((k, i) => { dims[k.d.name] = i < active ? value(k, row) : "all"; });
    return dims;
  };
}
