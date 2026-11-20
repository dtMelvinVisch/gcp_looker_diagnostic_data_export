import { readFileSync } from "fs";
import { join } from "path";

export interface Metric { id: string; description: string }
export interface Catalog {
  model: string; explore: string; metricPrefix: string; unit: string;
  time: string; queryId: string; sql: string; biEngineMode: string;
  dimensions: { name: string; field: string; description: string }[];
  constantDimensions: { name: string; description: string }[];
  event: { type: string; provider: string; name: string };
  diagMetrics: { id: string; unit: string; description: string }[];
  groups: Record<string, { label: string; metrics: Metric[] }>;
}

export const catalog: Catalog = JSON.parse(readFileSync(join(__dirname, "..", "catalog.json"), "utf8"));

export const metricKey = (c: Catalog, group: string, id: string) => `${c.metricPrefix}.${group}.${id}.duration`;
export const metricField = (c: Catalog, id: string) => `${c.explore}.${id}`;

export function metricsOf(c: Catalog, groups: string[]) {
  return groups.flatMap((g) => (c.groups[g]?.metrics ?? []).map((m) => ({ group: g, ...m, key: metricKey(c, g, m.id), field: metricField(c, m.id) })));
}

export const allGroups = (c: Catalog) => Object.keys(c.groups);
export const allMetricIds = (c: Catalog) => metricsOf(c, allGroups(c)).map((m) => m.id);

/** Fields requested from Looker. Allow-list only: nothing user-related is ever requested. */
export function queryFields(c: Catalog, groups: string[], events: boolean): string[] {
  const metrics = metricsOf(c, events ? allGroups(c) : groups).map((m) => m.field);
  const extra = events ? [c.sql, c.biEngineMode] : [];
  return [...new Set([c.time, c.queryId, ...c.dimensions.map((d) => d.field), ...metrics, ...extra])];
}
export const lookerFields = (c: Catalog) => queryFields(c, allGroups(c), true);

export const diagKey = (c: Catalog, id: string) => `${c.metricPrefix}.diag.${id}`;

/** Metadata (unit, description) for every metric key the function can emit. */
export function metricInfo(c: Catalog): Map<string, { id: string; unit: string; description: string }> {
  const timing = metricsOf(c, allGroups(c)).map((m) => [m.key, { id: m.id, unit: c.unit, description: m.description }] as const);
  const diag = c.diagMetrics.map((m) => [diagKey(c, m.id), m] as const);
  return new Map([...timing, ...diag]);
}
