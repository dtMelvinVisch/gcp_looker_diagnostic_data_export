import { http } from "@google-cloud/functions-framework";
import { ConfigError, loadConfig, parsePayload } from "./config";
import { createLogger } from "./log";
import { runOnce } from "./run";
import { createGcsState } from "./state";

const out = (e: Record<string, unknown>) => console.log(JSON.stringify(e));

http("lookerDiag", async (req, res) => {
  if (req.method !== "POST") { res.status(405).send("POST only"); return; }
  const traceId = String(req.header("x-cloud-trace-context") ?? "").split("/")[0];
  let cfg;
  try { cfg = loadConfig(process.env); } catch (e) {
    const problems = e instanceof ConfigError ? e.problems : ["unexpected configuration error"];
    out({ severity: "ERROR", message: "invalid configuration", problems });
    res.status(500).json({ error: "invalid configuration", problems }); return;
  }
  const trace = traceId ? `projects/${cfg.project}/traces/${traceId}` : undefined;
  let payload;
  try { payload = parsePayload(req.body); } catch (e) { res.status(400).json({ error: (e as ConfigError).problems }); return; }
  const fetchFn = (url: string, init?: RequestInit) => fetch(url, init);
  const deps = {
    fetch: fetchFn, state: createGcsState(fetchFn, cfg.stateBucket), now: Date.now, random: Math.random,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), log: out, trace,
  };
  try {
    const r = await runOnce(deps, cfg, payload);
    res.status(200).json({ status: r.status, stats: r.stats });
  } catch (e) {
    createLogger(out, cfg.logLevel, { job: payload.job, ...(trace ? { "logging.googleapis.com/trace": trace } : {}) }, cfg.secrets, Date.now)
      .error("run failed", { error: (e as Error).message });
    res.status(500).json({ error: "run failed" });
  }
});
