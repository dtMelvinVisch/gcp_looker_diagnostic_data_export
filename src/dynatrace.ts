import type { Config } from "./config";
import type { DtEvent } from "./events";
import { HttpError, type Net, send } from "./http";

const headers = (cfg: Config, type: string) => ({ Authorization: `Bearer ${cfg.dtToken}`, "Content-Type": type });
const fatal = (what: string, status: number) => new HttpError(`Dynatrace rejected ${what}: HTTP ${status}`, status, true);

/** POST one metrics payload. 202 = accepted; 400 = partial, valid lines are kept and the invalid ones are logged (never retried). */
export async function sendMetrics(net: Net, cfg: Config, payload: string, lines: number): Promise<void> {
  const res = await send(net, "Dynatrace", `${cfg.dtEnvUrl}/api/v2/metrics/ingest`, { method: "POST", headers: headers(cfg, "text/plain; charset=utf-8"), body: payload });
  if (res.status === 202) { net.stats.linesSent += lines; return; }
  if (res.status !== 400) throw fatal("metrics", res.status);
  const b = (await res.json().catch(() => ({}))) as { linesOk?: number; linesInvalid?: number; error?: { invalidLines?: { line: number; error: string }[] } };
  const ok = b.linesOk ?? 0;
  const bad = b.linesInvalid ?? lines - ok;
  net.stats.linesSent += ok; net.stats.linesRejected += bad;
  net.log.error("metrics rejected by Dynatrace", { linesOk: ok, linesInvalid: bad, examples: (b.error?.invalidLines ?? []).slice(0, 3).map((l) => ({ line: l.line, error: String(l.error).slice(0, 200) })) });
}

const EVENTS_PER_REQUEST = 500;
const EVENTS_MAX_BYTES = 4_000_000;

/** POST slow-query events in batches (no partial-failure shape is documented: a 400 rejects the whole batch). */
export async function sendEvents(net: Net, cfg: Config, events: DtEvent[]): Promise<void> {
  const batches: DtEvent[][] = [];
  let cur: DtEvent[] = []; let bytes = 0;
  for (const e of events) {
    const b = Buffer.byteLength(JSON.stringify(e));
    if (cur.length && (cur.length >= EVENTS_PER_REQUEST || bytes + b > EVENTS_MAX_BYTES)) { batches.push(cur); cur = []; bytes = 0; }
    cur.push(e); bytes += b;
  }
  if (cur.length) batches.push(cur);
  for (const batch of batches) {
    const res = await send(net, "Dynatrace", `${cfg.dtEnvUrl}/platform/ingest/v1/events`, { method: "POST", headers: headers(cfg, "application/json"), body: JSON.stringify(batch) });
    if (res.status === 202) { net.stats.eventsSent += batch.length; continue; }
    if (res.status !== 400) throw fatal("events", res.status);
    net.stats.eventsRejected += batch.length;
    net.log.error("events rejected by Dynatrace", { events: batch.length, status: 400 });
  }
}
