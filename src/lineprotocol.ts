import { type Catalog, metricInfo } from "./catalog";
import type { Point } from "./aggregate";

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const num = (n: number) => Number(n.toFixed(6)).toString();
const title = (id: string) => { const s = id.replace(/_/g, " "); return s[0]!.toUpperCase() + s.slice(1); };

export interface Limits { maxLines: number; maxBytes: number }

/** Build Metrics API v2 payloads: gauge summary lines plus one metadata line (unit, description) per metric per payload. */
export function buildPayloads(points: Point[], catalog: Catalog, limits: Limits): { payloads: string[]; lines: number } {
  const info = metricInfo(catalog);
  const meta = (key: string) => {
    const m = info.get(key)!;
    return `#${key} gauge dt.meta.displayname="${esc(title(m.id))}",dt.meta.description="${esc(m.description)}",dt.meta.unit="${m.unit}"\n`;
  };
  const payloads: string[] = [];
  let metaLines: string[] = []; let dataLines: string[] = []; let seen = new Set<string>(); let bytes = 0;
  const flush = () => { if (dataLines.length) payloads.push(metaLines.join("") + dataLines.join("")); metaLines = []; dataLines = []; seen = new Set(); bytes = 0; };
  for (const p of points) {
    const dims = Object.entries(p.dims).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${esc(v)}"`).join(",");
    const line = `${p.key},${dims} gauge,min=${num(p.min)},max=${num(p.max)},sum=${num(p.sum)},count=${p.count} ${p.minute}\n`;
    const m = seen.has(p.key) ? "" : meta(p.key);
    const add = Buffer.byteLength(line) + Buffer.byteLength(m);
    if (dataLines.length && (metaLines.length + dataLines.length + (m ? 2 : 1) > limits.maxLines || bytes + add > limits.maxBytes)) flush();
    const m2 = seen.has(p.key) ? "" : meta(p.key);
    if (m2) { metaLines.push(m2); seen.add(p.key); }
    dataLines.push(line); bytes += Buffer.byteLength(line) + Buffer.byteLength(m2);
  }
  flush();
  return { payloads, lines: points.length };
}
