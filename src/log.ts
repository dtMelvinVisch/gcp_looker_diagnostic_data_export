export type Level = "debug" | "info" | "warn" | "error";
export type LogFn = (entry: Record<string, unknown>) => void;
export interface Logger { debug: LogMethod; info: LogMethod; warn: LogMethod; error: LogMethod }
type LogMethod = (message: string, fields?: Record<string, unknown>) => void;

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const SEVERITY: Record<Level, string> = { debug: "DEBUG", info: "INFO", warn: "WARNING", error: "ERROR" };
const SENSITIVE_KEY = /token|secret|authorization|password|sql|query\.text/i;

export function scrub(v: unknown, secrets: string[], depth = 0): unknown {
  if (typeof v === "string") return secrets.reduce((s, x) => (x.length >= 4 ? s.split(x).join("[redacted]") : s), v);
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, secrets, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SENSITIVE_KEY.test(k) ? "[redacted]" : scrub(x, secrets, depth + 1)]));
}

export function createLogger(sink: LogFn, level: Level, base: Record<string, unknown>, secrets: string[], now: () => number): Logger {
  const make = (l: Level): LogMethod => (message, fields = {}) => {
    if (RANK[l] < RANK[level]) return;
    sink(scrub({ severity: SEVERITY[l], message, time: new Date(now()).toISOString(), ...base, ...fields }, secrets) as Record<string, unknown>);
  };
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}
