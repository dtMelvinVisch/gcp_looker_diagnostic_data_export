import type { Logger } from "./log";

export class HttpError extends Error {
  constructor(message: string, public status?: number, public fatal = false) { super(message); }
}
export interface Stats {
  rows: number; queries: number; linesSent: number; linesRejected: number; eventsSent: number; eventsRejected: number;
  retries: number; lookerMs: number; dtMs: number; truncated: number; outOfRange: number; skippedRows: number; lateRows: number;
}
export const newStats = (): Stats => ({ rows: 0, queries: 0, linesSent: 0, linesRejected: 0, eventsSent: 0, eventsRejected: 0, retries: 0, lookerMs: 0, dtMs: 0, truncated: 0, outOfRange: 0, skippedRows: 0, lateRows: 0 });

export interface Net {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>; now: () => number; random: () => number;
  stats: Stats; log: Logger; deadline: number; timeoutMs: number;
}
const MAX_ATTEMPTS = 3;
const retryable = (s: number) => s === 429 || s >= 500;

/** fetch with timeout, no redirects, bounded retries (network errors, 429, 5xx) with jittered backoff, honouring Retry-After and the run deadline. */
export async function send(net: Net, label: "Looker" | "Dynatrace", url: string, init: RequestInit): Promise<Response> {
  let last = "network error";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = performance.now();
    let res: Response | undefined;
    try {
      const budget = net.deadline - net.now();
      if (budget <= 0) throw new HttpError(`${label} request skipped: run deadline reached`, undefined, true);
      res = await net.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(Math.min(net.timeoutMs, budget)) });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      last = "network error or timeout";
    }
    net.stats[label === "Looker" ? "lookerMs" : "dtMs"] += performance.now() - t0;
    if (res && !retryable(res.status)) return res;
    if (res) last = `HTTP ${res.status}`;
    if (attempt === MAX_ATTEMPTS) break;
    const ra = Number(res?.headers.get("retry-after"));
    const delay = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 500 * 2 ** (attempt - 1) * (0.5 + net.random());
    if (net.now() + delay >= net.deadline) break;
    net.stats.retries++;
    net.log.warn(`${label} request failed, retrying`, { attempt, reason: last, delayMs: Math.round(delay) });
    await net.sleep(delay);
  }
  throw new HttpError(`${label} request failed after retries: ${last}`);
}
