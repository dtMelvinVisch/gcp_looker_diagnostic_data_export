import { type Point, aggregate } from "./aggregate";
import { catalog, diagKey, queryFields } from "./catalog";
import type { Config, Payload } from "./config";
import { constantDims, makeDimResolver, type Row } from "./dims";
import { sendEvents, sendMetrics } from "./dynatrace";
import { buildEvents } from "./events";
import { type Net, type Stats, newStats } from "./http";
import { buildPayloads } from "./lineprotocol";
import { countByMinute, detectLate } from "./late";
import { type LogFn, createLogger } from "./log";
import { login, queryRows, validateFields } from "./looker";
import type { State } from "./state";

export interface RunDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  state: State; now: () => number; sleep: (ms: number) => Promise<void>; random: () => number;
  log: LogFn; trace?: string;
}
const MIN = 60_000;

/** One idempotent run: closed minutes [watermark, now - lag), watermark advanced only after Looker read and Dynatrace sends succeeded. */
export async function runOnce(deps: RunDeps, cfg: Config, p: Payload): Promise<{ status: "ok" | "skipped"; stats: Stats; window?: [number, number] }> {
  const t0 = deps.now();
  const log = createLogger(deps.log, cfg.logLevel, { job: p.job, groups: p.groups, ...(deps.trace ? { "logging.googleapis.com/trace": deps.trace } : {}) }, cfg.secrets, deps.now);
  const stats = newStats();
  const net: Net = { ...deps, stats, log, deadline: t0 + cfg.deadlineMs, timeoutMs: cfg.requestTimeoutMs };

  const end = Math.floor((t0 - cfg.lagS * 1000) / MIN) * MIN;
  const { watermark, generation, counts: prior = {} } = await deps.state.read(p.job);
  let start = watermark ?? end - p.windowMin * MIN;
  if (start >= end) { log.info("nothing to do, watermark is current", { watermark: new Date(start).toISOString() }); return { status: "skipped", stats }; }
  const oldest = end - cfg.maxCatchupMin * MIN;
  if (start < oldest) {
    log.warn("watermark gap, skipping data older than the catch-up cap", { from: new Date(start).toISOString(), resumedAt: new Date(oldest).toISOString() });
    start = oldest;
  }

  const fields = queryFields(catalog, p.groups, p.events);
  const token = await login(net, cfg);
  await validateFields(net, cfg, token, catalog, fields);

  const fetchWindow = async (a: number, b: number): Promise<Row[]> => {
    const rows = await queryRows(net, cfg, token, catalog, fields, a, b);
    if (rows.length < cfg.rowLimit) return rows;
    if (b - a <= MIN) { stats.truncated++; log.error("row limit reached for a single minute, data truncated", { minute: new Date(a).toISOString(), limit: cfg.rowLimit }); return rows; }
    const mid = a + Math.max(1, Math.floor((b - a) / 2 / MIN)) * MIN;
    return [...(await fetchWindow(a, mid)), ...(await fetchWindow(mid, b))];
  };
  const rows = await fetchWindow(start, end);
  stats.rows = rows.length;

  const resolve = makeDimResolver(rows, cfg, catalog);
  const agg = aggregate(rows, resolve, catalog, p.groups);
  stats.skippedRows = agg.skipped;
  const points = agg.points.filter((x) => x.minute >= deps.now() - 58 * MIN && x.minute <= deps.now() + 5 * MIN);
  stats.outOfRange = agg.points.length - points.length;
  if (stats.outOfRange) log.warn("points outside the Dynatrace timestamp range dropped (clock skew or very late data)", { dropped: stats.outOfRange });

  const sendPoints = async (pts: Point[]) => {
    const { payloads } = buildPayloads(pts, catalog, { maxLines: 500, maxBytes: 200_000 });
    let remaining = pts.length;
    for (const body of payloads) {
      const lines = Math.min(remaining, body.split("\n").filter((l) => l && !l.startsWith("#")).length);
      remaining -= lines;
      await sendMetrics(net, cfg, body, lines);
    }
  };
  await sendPoints(points);
  if (p.events) {
    const ev = buildEvents(rows, resolve, catalog, cfg);
    if (ev.dropped) log.warn("slow queries without id or time skipped", { dropped: ev.dropped });
    if (ev.events.length) await sendEvents(net, cfg, ev.events);
  }

  let counts: Record<string, number> | undefined;
  if (p.lateCheckMin > 0) {
    counts = { ...prior };
    if (!stats.truncated) {
      for (let m = start; m < end; m += MIN) counts[m] = 0;
      Object.assign(counts, countByMinute(rows, catalog));
    }
    const from = end - p.lateCheckMin * MIN;
    const recorded = Object.fromEntries(Object.entries(prior).filter(([k]) => Number(k) >= from && Number(k) < start));
    try {
      if (Object.keys(recorded).length) {
        const again = await queryRows(net, cfg, token, catalog, [catalog.time, catalog.queryId], from, start);
        if (again.length >= cfg.rowLimit) log.warn("late-row check skipped, row limit reached", { limit: cfg.rowLimit });
        else {
          const d = detectLate(recorded, countByMinute(again, catalog), deps.now());
          Object.assign(counts, d.updated);
          stats.lateRows = d.late;
          const base = { minute: Math.floor(deps.now() / MIN) * MIN, dims: constantDims(cfg), count: 1 };
          await sendPoints([
            { key: diagKey(catalog, "late_rows"), min: d.late, max: d.late, sum: d.late, ...base },
            { key: diagKey(catalog, "late_delay"), min: d.delayS, max: d.delayS, sum: d.delayS, ...base },
          ]);
          if (d.late) log.warn("late rows detected, consider raising LAG_SECONDS", { lateRows: d.late, maxDelayUpperBoundS: d.delayS, lagS: cfg.lagS });
        }
      }
    } catch (e) {
      log.warn("late-row check failed, continuing", { error: (e as Error).message });
    }
    for (const k of Object.keys(counts)) if (Number(k) < end - 60 * MIN) delete counts[k];
  }

  const advanced = await deps.state.write(p.job, end, generation, counts);
  if (!advanced) log.warn("concurrent run won the watermark, not advancing");
  log.info("run complete", { windowStart: new Date(start).toISOString(), windowEnd: new Date(end).toISOString(), durationMs: deps.now() - t0, versionCaveat: cfg.versionCaveat, ...stats });
  return { status: "ok", stats, window: [start, end] };
}
