import type { Catalog } from "./catalog";
import type { Config } from "./config";
import type { Row } from "./dims";
import { HttpError, type Net, send } from "./http";
import { fmtLooker } from "./util";

const api = (cfg: Config, path: string) => `${cfg.lookerBaseUrl}/api/4.0${path}`;

export async function login(net: Net, cfg: Config): Promise<string> {
  const res = await send(net, "Looker", api(cfg, "/login"), {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.lookerClientId, client_secret: cfg.lookerClientSecret }).toString(),
  });
  if (!res.ok) throw new HttpError(`Looker login failed: HTTP ${res.status}`, res.status, true);
  const token = ((await res.json()) as { access_token?: string }).access_token;
  if (!token) throw new HttpError("Looker login returned no access token", res.status, true);
  return token;
}

/** Fail with the exact list of unknown fields instead of an opaque query error. */
export async function validateFields(net: Net, cfg: Config, token: string, c: Catalog, fields: string[]): Promise<void> {
  const url = api(cfg, `/lookml_models/${encodeURIComponent(c.model)}/explores/${encodeURIComponent(c.explore)}?fields=fields`);
  const res = await send(net, "Looker", url, { headers: { Authorization: `token ${token}` } });
  if (!res.ok) throw new HttpError(`Looker explore lookup failed: HTTP ${res.status} (is see_system_activity granted?)`, res.status, true);
  const f = ((await res.json()) as { fields?: { dimensions?: { name: string }[]; measures?: { name: string }[] } }).fields ?? {};
  const known = new Set([...(f.dimensions ?? []), ...(f.measures ?? [])].map((x) => x.name));
  const missing = fields.filter((x) => !known.has(x));
  if (missing.length) throw new HttpError(`Unknown Looker fields (fix catalog.json): ${missing.join(", ")}`, undefined, true);
}

export async function queryRows(net: Net, cfg: Config, token: string, c: Catalog, fields: string[], startMs: number, endMs: number): Promise<Row[]> {
  const body = {
    model: c.model, view: c.explore, fields, limit: String(cfg.rowLimit), query_timezone: "UTC",
    filters: { [c.time]: `${fmtLooker(startMs)} to ${fmtLooker(endMs)}` }, sorts: [`${c.time} asc`],
  };
  net.stats.queries++;
  const res = await send(net, "Looker", api(cfg, `/queries/run/json${cfg.lookerBypassCache ? "?cache=false" : ""}`), {
    method: "POST", headers: { Authorization: `token ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new HttpError(`Looker query failed: HTTP ${res.status}`, res.status, true);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new HttpError("Looker query returned an unexpected body", res.status, true);
  return rows as Row[];
}
