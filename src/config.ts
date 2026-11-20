import { allGroups, allMetricIds, catalog } from "./catalog";
import type { Level } from "./log";

export class ConfigError extends Error {
  constructor(public problems: string[]) { super("Invalid configuration: " + problems.join("; ")); }
}

export interface Config {
  lookerBaseUrl: string; lookerDeployment: "core" | "original"; lookerInstance: string; versionCaveat: boolean;
  lookerClientId: string; lookerClientSecret: string; lookerBypassCache: boolean;
  dtEnvUrl: string; dtToken: string; region: string; project: string; stateBucket: string;
  slowField: string; slowThresholdS: number; lagS: number; maxCatchupMin: number; maxSeries: number; rowLimit: number; maxDimValues: number;
  requestTimeoutMs: number; deadlineMs: number; logLevel: Level; secrets: string[];
}
export interface Payload { job: string; groups: string[]; events: boolean; windowMin: number; lateCheckMin: number }

type Env = Record<string, string | undefined>;
const LEVELS = ["debug", "info", "warn", "error"];

function safeUrl(name: string, raw: string | undefined, problems: string[], opts: { suffixes?: string[]; ports?: string[] }): string {
  try {
    const u = new URL(raw ?? "");
    const h = u.hostname.toLowerCase();
    const bad =
      u.protocol !== "https:" || u.username || u.password ||
      /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || h === "localhost" || /\.(internal|local|localhost)$/.test(h) ||
      (opts.suffixes && !opts.suffixes.some((s) => h.endsWith(s))) ||
      !(opts.ports ?? [""]).includes(u.port);
    if (bad) throw new Error("unsafe");
    return u.origin;
  } catch {
    problems.push(`${name} must be an https URL to a public DNS host${opts.suffixes ? ` ending in ${opts.suffixes.join(" or ")}` : ""}`);
    return "";
  }
}

export function loadConfig(env: Env): Config {
  const problems: string[] = [];
  const str = (name: string): string => {
    const v = (env[name] ?? "").trim();
    if (!v) problems.push(`${name} is required`);
    return v;
  };
  const num = (name: string, def: number, min: number, max: number): number => {
    const raw = env[name]; if (raw === undefined || raw === "") return def;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < min || v > max) { problems.push(`${name} must be a number between ${min} and ${max}`); return def; }
    return v;
  };
  const deployment = (env.LOOKER_DEPLOYMENT ?? "core") as "core" | "original";
  if (deployment !== "core" && deployment !== "original") problems.push("LOOKER_DEPLOYMENT must be 'core' or 'original'");
  const logLevel = (env.LOG_LEVEL ?? "info") as Level;
  if (!LEVELS.includes(logLevel)) problems.push(`LOG_LEVEL must be one of ${LEVELS.join(", ")}`);
  const slowField = env.SLOW_QUERY_FIELD ?? "async_processing";
  if (!allMetricIds(catalog).includes(slowField)) problems.push("SLOW_QUERY_FIELD must be a metric id from the catalog");
  const suffixes = (env.DT_HOST_SUFFIXES ?? ".dynatrace.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const v = /^(\d+)\.(\d+)/.exec(env.LOOKER_VERSION ?? "");
  const versionCaveat = !v || Number(v[1]) < 26 || (Number(v[1]) === 26 && Number(v[2]) < 20);

  const cfg: Config = {
    lookerBaseUrl: safeUrl("LOOKER_BASE_URL", env.LOOKER_BASE_URL, problems, { ports: deployment === "original" ? ["", "443", "19999"] : ["", "443"] }),
    lookerDeployment: deployment, lookerInstance: str("LOOKER_INSTANCE").slice(0, 100), versionCaveat,
    lookerClientId: str("LOOKER_CLIENT_ID"), lookerClientSecret: str("LOOKER_CLIENT_SECRET"),
    lookerBypassCache: (env.LOOKER_BYPASS_CACHE ?? "true") !== "false",
    dtEnvUrl: safeUrl("DT_ENV_URL", env.DT_ENV_URL, problems, { suffixes }), dtToken: str("DT_TOKEN"),
    region: str("REGION"), project: str("GCP_PROJECT_ID"), stateBucket: str("STATE_BUCKET"),
    slowField, slowThresholdS: num("SLOW_QUERY_THRESHOLD_S", 30, 0, 86_400),
    lagS: num("LAG_SECONDS", 300, 0, 3600), maxCatchupMin: num("MAX_CATCHUP_MIN", 50, 1, 58), maxSeries: num("MAX_SERIES", 500, 1, 10_000),
    rowLimit: num("ROW_LIMIT", 5000, 10, 50_000), maxDimValues: num("MAX_DIM_VALUES", 20, 1, 500),
    requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 15_000, 1000, 120_000), deadlineMs: num("RUN_DEADLINE_MS", 45_000, 5000, 3_000_000),
    logLevel, secrets: [],
  };
  if (cfg.maxCatchupMin * 60 + cfg.lagS > 58 * 60) problems.push("MAX_CATCHUP_MIN plus LAG_SECONDS must stay within the 58 minutes Dynatrace accepts for metric timestamps");
  if (problems.length) throw new ConfigError(problems);
  cfg.secrets = [cfg.lookerClientId, cfg.lookerClientSecret, cfg.dtToken];
  return cfg;
}

export function parsePayload(body: unknown): Payload {
  const b = body as Record<string, unknown> | null;
  const problems: string[] = [];
  if (!b || typeof b !== "object") throw new ConfigError(["request body must be a JSON object"]);
  const job = String(b.job ?? "");
  if (!/^[a-z0-9-]{1,40}$/.test(job)) problems.push("job must match [a-z0-9-]{1,40}");
  const groups = Array.isArray(b.groups) ? b.groups.map(String) : [];
  if (!groups.length || groups.some((g) => !allGroups(catalog).includes(g))) problems.push(`groups must be a non-empty subset of ${allGroups(catalog).join(", ")}`);
  const windowMin = b.windowMin === undefined ? 1 : Number(b.windowMin);
  if (!Number.isInteger(windowMin) || windowMin < 1 || windowMin > 60) problems.push("windowMin must be an integer 1-60");
  const lateCheckMin = b.lateCheckMin === undefined ? 0 : Number(b.lateCheckMin);
  if (!Number.isInteger(lateCheckMin) || lateCheckMin < 0 || lateCheckMin > 58) problems.push("lateCheckMin must be an integer 0-58 (0 = off)");
  if (problems.length) throw new ConfigError(problems);
  return { job, groups, events: b.events === true, windowMin, lateCheckMin };
}
