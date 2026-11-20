import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { catalog, lookerFields } from "../src/catalog";
import { runOnce, type RunDeps } from "../src/run";
import type { State } from "../src/state";
import { baseEnv } from "./helpers";

const NOW = Date.UTC(2026, 10, 18, 10, 7, 30);
const END = Date.UTC(2026, 10, 18, 10, 2, 0); // floor(now - 300 s) to the minute
const cfg = loadConfig(baseEnv);
const payload = { job: "overall", groups: ["overall"], events: true, windowMin: 1 };
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers });

const goodRow = (id: number, secs: number, t = "2026-11-18 10:01:10") => ({
  "history.created_time": t, "query.id": id, "query.model": "m", "query.view": "e", "history.source": "dashboard", "history.status": "complete",
  "query.sql": "SELECT * FROM t WHERE email = 'a@b.com'", "query_performance_metrics.async_processing": secs, "query_performance_metrics.connection_held": 1,
  "query_performance_metrics.execute_main_query": 2, "query_performance_metrics.bi_engine_mode": null,
});

interface Calls { url: string; method: string; body: string; headers: Record<string, string> }
function setup(over: { looker?: (body: any, url: string) => Response; metrics?: () => Response; events?: () => Response; unknownField?: string; wm?: number | null; counts?: Record<string, number> } = {}) {
  const calls: Calls[] = [];
  const logs: Record<string, unknown>[] = [];
  const written: number[] = []; const writtenCounts: (Record<string, number> | undefined)[] = [];
  const state: State = {
    read: async () => ({ watermark: over.wm === undefined ? null : over.wm, generation: "5", counts: over.counts }),
    write: async (_j, wm, _g, counts) => { written.push(wm); writtenCounts.push(counts); return true; },
  };
  const fields = lookerFields(catalog).filter((f) => f !== over.unknownField);
  const fetch: RunDeps["fetch"] = async (url, init) => {
    const body = String(init?.body ?? "");
    calls.push({ url, method: init?.method ?? "GET", body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith("/api/4.0/login")) return json({ access_token: "LOOKER-TOKEN-XYZ", expires_in: 3600 });
    if (url.includes("/lookml_models/")) return json({ fields: { dimensions: fields.map((name) => ({ name })), measures: [] } });
    if (url.includes("/queries/run/json")) return (over.looker ?? (() => json([goodRow(1, 50), goodRow(2, 3)])))(JSON.parse(body), url);
    if (url.endsWith("/api/v2/metrics/ingest")) return (over.metrics ?? (() => json({ linesOk: 3, linesInvalid: 0 }, 202)))();
    if (url.endsWith("/platform/ingest/v1/events")) return (over.events ?? (() => new Response(null, { status: 202 })))();
    throw new Error("unexpected url " + url);
  };
  const deps: RunDeps = { fetch, state, now: () => NOW, sleep: async () => {}, random: () => 0.5, log: (e) => logs.push(e) };
  return { deps, calls, logs, written, writtenCounts };
}

let t: ReturnType<typeof setup>;
beforeEach(() => { t = setup(); });

describe("runOnce integration (mocked Looker + Dynatrace)", () => {
  it("happy path: queries Looker once, sends metrics + one slow event, advances watermark", async () => {
    const r = await runOnce(t.deps, cfg, payload);
    expect(r.status).toBe("ok");
    const q = t.calls.find((c) => c.url.includes("/queries/run/json"))!;
    const body = JSON.parse(q.body);
    expect(body.filters["history.created_time"]).toBe("2026-11-18 10:01:00 to 2026-11-18 10:02:00");
    expect(body.query_timezone).toBe("UTC");
    expect(body.fields.join(",")).not.toMatch(/user\./);
    expect(q.headers.Authorization).toBe("token LOOKER-TOKEN-XYZ");
    const m = t.calls.find((c) => c.url.endsWith("/metrics/ingest"))!;
    expect(m.headers.Authorization).toBe("Bearer " + baseEnv.DT_TOKEN);
    expect(m.body).toContain("custom.gcp.looker.overall.async_processing.duration,");
    const e = JSON.parse(t.calls.find((c) => c.url.endsWith("/events"))!.body);
    expect(e).toHaveLength(1);
    expect(e[0]["looker.query.id"]).toBe("1");
    expect(e[0]["db.query.text"]).toBe("SELECT * FROM t WHERE email = *");
    expect(t.written).toEqual([END]);
    expect(r.stats).toMatchObject({ rows: 2, eventsSent: 1 });
  });

  it("does not send events when payload.events is false", async () => {
    await runOnce(t.deps, cfg, { ...payload, events: false });
    expect(t.calls.some((c) => c.url.endsWith("/events"))).toBe(false);
  });

  it("logs partial metric failures and still advances (bad lines never retried)", async () => {
    t = setup({ metrics: () => json({ linesOk: 1, linesInvalid: 2, error: { code: 400, message: "x", invalidLines: [{ line: 3, error: "bad" }] } }, 400) });
    const r = await runOnce(t.deps, cfg, payload);
    expect(r.stats.linesRejected).toBe(2);
    expect(t.logs.some((l) => l.severity === "ERROR" && String(l.message).includes("rejected"))).toBe(true);
    expect(t.written).toEqual([END]);
  });

  it("Looker down: bounded retries, nothing sent, watermark kept", async () => {
    t = setup({ looker: () => json({ message: "down" }, 503) });
    await expect(runOnce(t.deps, cfg, payload)).rejects.toThrow(/Looker/);
    expect(t.calls.filter((c) => c.url.includes("/queries/run/json"))).toHaveLength(3);
    expect(t.calls.some((c) => c.url.includes("dynatrace"))).toBe(false);
    expect(t.written).toEqual([]);
  });

  it("Dynatrace transient 503 is retried then succeeds", async () => {
    let n = 0;
    t = setup({ metrics: () => (n++ === 0 ? json({}, 503) : json({}, 202)) });
    const r = await runOnce(t.deps, cfg, payload);
    expect(r.stats.retries).toBe(1);
    expect(t.written).toEqual([END]);
  });

  it("Dynatrace 429 honours Retry-After and gives up after bounded retries without advancing", async () => {
    t = setup({ metrics: () => json({}, 429, { "retry-after": "1" }) });
    await expect(runOnce(t.deps, cfg, payload)).rejects.toThrow(/Dynatrace/);
    expect(t.calls.filter((c) => c.url.endsWith("/metrics/ingest"))).toHaveLength(3);
    expect(t.written).toEqual([]);
  });

  it("Dynatrace 401 is fatal (no retry, no advance) and the token never reaches logs", async () => {
    t = setup({ metrics: () => json({ error: { code: 401, message: "bad token dt0s16.TOKEN.SECRETSECRET" } }, 401) });
    await expect(runOnce(t.deps, cfg, payload)).rejects.toThrow(/401/);
    expect(t.calls.filter((c) => c.url.endsWith("/metrics/ingest"))).toHaveLength(1);
    expect(t.written).toEqual([]);
    expect(JSON.stringify(t.logs)).not.toMatch(/SECRETSECRET|client-secret|LOOKER-TOKEN/);
  });

  it("unknown Looker field: clear error listing the field, no data query", async () => {
    t = setup({ unknownField: "query.sql" });
    await expect(runOnce(t.deps, cfg, payload)).rejects.toThrow(/query\.sql/);
    expect(t.calls.some((c) => c.url.includes("/queries/run/json"))).toBe(false);
  });

  it("missed runs: catches up from the watermark, capped at MAX_CATCHUP with a gap warning", async () => {
    t = setup({ wm: END - 2 * 3600_000 });
    await runOnce(t.deps, cfg, payload);
    const body = JSON.parse(t.calls.find((c) => c.url.includes("/queries/run/json"))!.body);
    expect(body.filters["history.created_time"]).toBe("2026-11-18 09:12:00 to 2026-11-18 10:02:00");
    expect(t.logs.some((l) => l.severity === "WARNING" && String(l.message).includes("gap"))).toBe(true);
  });

  it("small gap: window starts exactly at the watermark", async () => {
    t = setup({ wm: END - 3 * 60_000 });
    await runOnce(t.deps, cfg, payload);
    const body = JSON.parse(t.calls.find((c) => c.url.includes("/queries/run/json"))!.body);
    expect(body.filters["history.created_time"]).toBe("2026-11-18 09:59:00 to 2026-11-18 10:02:00");
  });

  it("nothing to do when the watermark is already at the window end", async () => {
    t = setup({ wm: END });
    expect((await runOnce(t.deps, cfg, payload)).status).toBe("skipped");
    expect(t.calls).toHaveLength(0);
  });

  it("empty data: no Dynatrace calls, watermark advances", async () => {
    t = setup({ looker: () => json([]) });
    await runOnce(t.deps, cfg, payload);
    expect(t.calls.some((c) => c.url.includes("dynatrace"))).toBe(false);
    expect(t.written).toEqual([END]);
  });

  it("splits the window when the row limit is hit (no silent truncation)", async () => {
    const small = { ...cfg, rowLimit: 2 };
    t = setup({ wm: END - 4 * 60_000, looker: (b) => {
      const [a, z] = (b.filters["history.created_time"] as string).split(" to ");
      const minutes = (Date.parse(z!.replace(" ", "T") + "Z") - Date.parse(a!.replace(" ", "T") + "Z")) / 60000;
      const id = Date.parse(a!.replace(" ", "T") + "Z") / 60000;
      return json(minutes > 1 ? [goodRow(id, 1, a), goodRow(id + 0.5, 1, a)] : [goodRow(id, 1, a)]);
    } });
    const r = await runOnce(t.deps, small, { ...payload, events: false });
    expect(t.calls.filter((c) => c.url.includes("/queries/run/json")).length).toBeGreaterThan(1);
    expect(r.stats.truncated).toBe(0);
  });

  it("logs never contain secrets, tokens or unmasked SQL", async () => {
    await runOnce(t.deps, cfg, payload);
    expect(JSON.stringify(t.logs)).not.toMatch(/SECRETSECRET|client-secret|LOOKER-TOKEN|a@b\.com/);
  });

  it("drops points outside the Dynatrace timestamp range instead of failing the request", async () => {
    t = setup({ looker: () => json([goodRow(1, 3, "2026-11-18 10:40:00")]) });
    const r = await runOnce(t.deps, cfg, { ...payload, events: false });
    expect(r.stats.outOfRange).toBeGreaterThan(0);
    expect(t.calls.some((c) => c.url.endsWith("/metrics/ingest"))).toBe(false);
  });

  it("does not advance when a concurrent run won the watermark race", async () => {
    t.deps.state.write = async () => false;
    const r = await runOnce(t.deps, cfg, payload);
    expect(t.logs.some((l) => String(l.message).includes("concurrent"))).toBe(true);
    expect(r.status).toBe("ok");
  });

  describe("late-row check", () => {
    const M = (h: number, m: number) => Date.UTC(2026, 10, 18, h, m);
    const late = { ...payload, job: "detail", events: false, lateCheckMin: 10 };
    const lateSetup = (looker?: (b: any) => Response) => setup({
      wm: END - 3 * 60_000, counts: { [M(9, 55)]: 1, [M(9, 56)]: 1 },
      looker: looker ?? ((b) => b.fields.length === 2
        ? json([{ "history.created_time": "2026-11-18 09:55:10", "query.id": 1 }, { "history.created_time": "2026-11-18 09:55:20", "query.id": 2 }, { "history.created_time": "2026-11-18 09:56:30", "query.id": 3 }])
        : json([goodRow(9, 1)])),
    });
    it("is off by default (no extra Looker query, no diag metric)", async () => {
      t = lateSetup();
      await runOnce(t.deps, cfg, { ...late, lateCheckMin: 0 });
      expect(t.calls.filter((c) => c.url.includes("/queries/run/json"))).toHaveLength(1);
    });
    it("counts rows that appeared after their minute was processed, reports them once, and updates the recorded counts", async () => {
      t = lateSetup();
      const r = await runOnce(t.deps, cfg, late);
      expect(r.stats.lateRows).toBe(1);
      const diag = t.calls.filter((c) => c.url.endsWith("/metrics/ingest") && c.body.includes("diag.late_rows"))[0]!;
      expect(diag.body).toMatch(/custom\.gcp\.looker\.diag\.late_rows,[^\n]* gauge,min=1,max=1,sum=1,count=1 /);
      expect(diag.body).toMatch(/diag\.late_delay,[^\n]* gauge,min=690,/);
      expect(diag.body).toContain('dt.meta.unit="Count"');
      expect(t.logs.some((l) => l.severity === "WARNING" && String(l.message).includes("late rows detected"))).toBe(true);
      const c = t.writtenCounts[0]!;
      expect(c[M(9, 55)]).toBe(2);
      expect(c[M(10, 1)]).toBe(1); // the window just processed is recorded
    });
    it("a failing late check never fails the run", async () => {
      t = lateSetup((b) => (b.fields.length === 2 ? json({}, 400) : json([goodRow(9, 1)])));
      const r = await runOnce(t.deps, cfg, late);
      expect(r.status).toBe("ok");
      expect(t.written).toEqual([END]);
      expect(t.logs.some((l) => String(l.message).includes("late-row check failed"))).toBe(true);
    });
  });
});
