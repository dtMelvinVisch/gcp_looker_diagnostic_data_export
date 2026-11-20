import type { Catalog } from "./catalog";
import type { Row } from "./dims";
import { parseUtc } from "./util";

const MIN = 60_000;

export function countByMinute(rows: Row[], c: Catalog): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const t = parseUtc(r[c.time]);
    if (!Number.isNaN(t)) { const m = Math.floor(t / MIN) * MIN; out[m] = (out[m] ?? 0) + 1; }
  }
  return out;
}

/**
 * Compare the row count recorded when a minute was processed with today's count.
 * delay is an upper bound: time between the minute closing and now (the first run that saw the extra rows).
 */
export function detectLate(recorded: Record<string, number>, current: Record<string, number>, nowMs: number) {
  let late = 0; let delayS = 0;
  const updated: Record<string, number> = {};
  for (const [k, was] of Object.entries(recorded)) {
    const extra = (current[k] ?? 0) - was;
    if (extra > 0) { late += extra; delayS = Math.max(delayS, Math.round((nowMs - (Number(k) + MIN)) / 1000)); updated[k] = current[k]!; }
  }
  return { late, delayS, updated };
}
