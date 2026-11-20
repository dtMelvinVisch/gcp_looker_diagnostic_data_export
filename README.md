# GCP Looker Diagnostics → Dynatrace

Collects Looker performance diagnostics (the **Query Performance Metrics** Explore of the `system__activity` model) and sends them to Dynatrace:

- **Metrics** `custom.gcp.looker.*`: per-minute gauges (min/max/sum/count), bounded dimensions, via Metrics API v2 line protocol.
- **Slow-query events**: one OpenPipeline event per query above a configurable threshold, with query ID, masked SQL, the full timing breakdown and the same dimensions as the metrics.

Phase 1 only: no logs, no traces, no PDT Event Log Explore (documented future phase). Nothing in this folder has been deployed.

## Architecture and layout

Cloud Run function (2nd gen, Node.js 22, TypeScript) triggered by Cloud Scheduler (OIDC). One run reads one closed time window from Looker with **one** Looker query, aggregates it per minute, posts metrics and events, then advances a watermark in a GCS object.

Layout evaluated (27 timing metrics in 5 groups):

| | (a) per metric | (b) per group | (c) one codebase, group payload |
|---|---|---|---|
| Scheduler jobs | 27 | 5 | **2** |
| Invocations / day | 38,880 | 7,200 | **1,728** (1,440 + 288) |
| Looker queries / min | 27 | 5 | **~1.2** (plus login and field check, see below) |
| Failure isolation | per metric, but all fail together when Looker is down | per group | overall (+ events) separated from detail |
| Deploy complexity | highest | medium | one function, two jobs |

**Chosen: (c).** All timing fields of a query come back in the same Looker row, so more metrics do not need more Looker queries; (a) and (b) only multiply load on System Activity, which Looker restricts in concurrency. Jobs:

- `looker-diag-overall`, every **1 min**: group `overall` ("Timings: Overall": `async_processing`, `connection_held`) + slow-query events. This meets the hard 1-minute requirement.
- `looker-diag-detail`, every 5 min: groups `queue`, `init`, `running`, `processing`, plus the late-row check (below). Each run still emits **per-minute** points for its 5-minute window (up to 5 min latency). Change `windowMin`/schedule in the job payload to make it 1 minute.

Each run makes 3 Looker calls (login, field validation, data query; more only if the row limit forces the window to be split).

## Metric and event catalog

Everything lives in [catalog.json](catalog.json); code is generic. Key pattern: `custom.gcp.looker.<group>.<field>.duration`, unit `Second`, one-sentence description (sent as metadata lines), modelled on the Grail built-in naming (`dt.*` is reserved, so `custom.` is used).

| Group (Looker section) | Metrics |
|---|---|
| `queue` | queued |
| `init` | acquire_connection, cache_load, explore_init_computed/_from_cache, model_init_computed/_from_cache, per_user_throttler, prepare, project_init |
| `running` | execute_main/totals/row_totals/grand_totals/misc_ancillary_queries, load_*_in_memory (5), load_process_and_stream_main_query, pdts, temporary_dt |
| `processing` | postprocessing, stream_to_cache |
| `overall` | async_processing, connection_held |

Not collected: the "Summaries" section (totals/averages, derivable from sum/count) and the BI Engine fields (BigQuery job ids are unbounded; only `bi_engine_mode` is added to events).

Bounded dimensions (metrics **and** events): `looker.instance`, `looker.model`, `looker.explore`, `looker.source`, `looker.status`, `gcp.project.id`, `gcp.region`. Query ID, SQL and user identity are never metric dimensions. Cardinality guards: per dimension only the top `MAX_DIM_VALUES` values per window are kept (rest → `other`), and if the combined combinations exceed `MAX_SERIES`, trailing dimensions collapse to `all`.

Slow-query event (`POST /platform/ingest/v1/events`): `event.id` (sha256 of instance + query id), `event.type=looker.slow_query`, `event.provider=looker`, `timestamp`, `looker.query.id`, `looker.slow_query.field/threshold_seconds`, the dimensions above, `looker.timing.<field>` for every timing, `looker.bi_engine.mode`, `db.query.text` (masked) and `looker.sql.masked`.

**Metric spike → events**: filter events on the same dimension values and the spike's time frame (see DQL below).

### Late-row check (measure, then tune `LAG_SECONDS`)

Rows that become visible in Looker after their minute was processed are not in the metrics (a second point on the same series and timestamp has undocumented behavior in Dynatrace, so metrics are never corrected). To size `LAG_SECONDS` from data instead of guessing, a job payload may set `lateCheckMin` (1-58; `0`/absent = off). Each run then records the row count per processed minute in the watermark object, and re-reads the previous `lateCheckMin` minutes (only `time` and `query id`, one extra Looker query) to count rows that appeared since. It emits:

- `custom.gcp.looker.diag.late_rows` (Count): late rows found in this check; each late row is reported once. `0` is sent too, so charts stay continuous.
- `custom.gcp.looker.diag.late_delay` (Second): upper bound of the delay (minute closed until the check that saw the rows).
- a `late rows detected, consider raising LAG_SECONDS` warning log.

Run it for a few days, then set `LAG_SECONDS` above the largest `late_delay` you see. A failing check logs a warning and never fails the run.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `LOOKER_BASE_URL` | required | https only, origin e.g. `https://acme.cloud.looker.com` |
| `LOOKER_DEPLOYMENT` | `core` | `core` (Looker Google Cloud core, port 443) or `original` (port 443 or 19999) |
| `LOOKER_VERSION` | – | e.g. `26.20`; below 26.20 or unset adds `versionCaveat=true` to the run log |
| `LOOKER_INSTANCE` | required | name used in `looker.instance` |
| `LOOKER_CLIENT_ID`, `LOOKER_CLIENT_SECRET` | required | from Secret Manager |
| `LOOKER_BYPASS_CACHE` | `true` | adds `cache=false` (see unverified items) |
| `DT_ENV_URL` | required | e.g. `https://abc12345.live.dynatrace.com` (host must end in `DT_HOST_SUFFIXES`, default `.dynatrace.com`) |
| `DT_TOKEN` | required | platform token, from Secret Manager |
| `REGION`, `GCP_PROJECT_ID` | required | `gcp.region` / `gcp.project.id` dimensions (Paris: `europe-west9`) |
| `STATE_BUCKET` | required | GCS bucket for watermarks |
| `SLOW_QUERY_FIELD` / `SLOW_QUERY_THRESHOLD_S` | `async_processing` / `30` | strictly greater than the limit |
| `LAG_SECONDS` | `300` | only closed minutes older than this are read (Explore data lag) |
| `MAX_CATCHUP_MIN` | `50` | max backlog per run; `+LAG_SECONDS` must stay ≤ 58 min |
| `ROW_LIMIT`, `MAX_DIM_VALUES`, `MAX_SERIES` | `5000`, `20`, `500` | |
| `REQUEST_TIMEOUT_MS`, `RUN_DEADLINE_MS` | `15000`, `45000` | deadline < 55 s function timeout < 60 s schedule |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

The environment is validated on every invocation; all problems are reported together (names only, never values).

## Required permissions

- **Looker**: a dedicated API user whose role has only `see_system_activity` (admins also work, but do not use one). API3 client id/secret. Looker (original) instances created before 7 July 2020 on AWS use `LOOKER_BASE_URL` with `:19999`.
- **Dynatrace**: platform token with `openpipeline:metrics:ingest` and `openpipeline:events:ingest`. (Classic equivalents: `metrics.ingest` and `openpipeline.events`; switching to classic `Api-Token` headers needs a code change.)
- **GCP**: runtime service account with `secretmanager.secretAccessor` on the three secrets and `storage.objectUser` on the state bucket only. Invoker service account with `run.invoker` on the function.

## Deployment (document only, nothing was run)

```bash
export PROJECT=my-project REGION=europe-west9 BUCKET=my-project-looker-diag-state
export LOOKER_URL=https://acme.cloud.looker.com DT_URL=https://abc12345.live.dynatrace.com INSTANCE=acme-prod
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com cloudfunctions.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com

# service accounts
gcloud iam service-accounts create looker-diag-runtime --display-name="Looker diag runtime"
gcloud iam service-accounts create looker-diag-invoker --display-name="Looker diag scheduler invoker"
RUNTIME_SA=looker-diag-runtime@$PROJECT.iam.gserviceaccount.com
INVOKER_SA=looker-diag-invoker@$PROJECT.iam.gserviceaccount.com

# secrets (values read from stdin, never on the command line)
for s in looker-client-id looker-client-secret dt-token; do
  gcloud secrets create $s --replication-policy=user-managed --locations=$REGION
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$RUNTIME_SA --role=roles/secretmanager.secretAccessor
done
printf '%s' "$LOOKER_CLIENT_ID"     | gcloud secrets versions add looker-client-id --data-file=-
printf '%s' "$LOOKER_CLIENT_SECRET" | gcloud secrets versions add looker-client-secret --data-file=-
printf '%s' "$DT_TOKEN"             | gcloud secrets versions add dt-token --data-file=-

# watermark bucket
gcloud storage buckets create gs://$BUCKET --location=$REGION --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding gs://$BUCKET --member=serviceAccount:$RUNTIME_SA --role=roles/storage.objectUser

# function (run from this folder)
gcloud functions deploy looker-diag --gen2 --region=$REGION --runtime=nodejs22 --source=. \
  --entry-point=lookerDiag --trigger-http --no-allow-unauthenticated \
  --service-account=$RUNTIME_SA --timeout=55s --memory=256Mi --max-instances=2 \
  --set-env-vars=LOOKER_BASE_URL=$LOOKER_URL,LOOKER_DEPLOYMENT=core,LOOKER_VERSION=26.20,LOOKER_INSTANCE=$INSTANCE,DT_ENV_URL=$DT_URL,REGION=$REGION,GCP_PROJECT_ID=$PROJECT,STATE_BUCKET=$BUCKET,SLOW_QUERY_THRESHOLD_S=30 \
  --set-secrets=LOOKER_CLIENT_ID=looker-client-id:latest,LOOKER_CLIENT_SECRET=looker-client-secret:latest,DT_TOKEN=dt-token:latest

URI=$(gcloud functions describe looker-diag --gen2 --region=$REGION --format='value(serviceConfig.uri)')
gcloud run services add-iam-policy-binding looker-diag --region=$REGION --member=serviceAccount:$INVOKER_SA --role=roles/run.invoker

# scheduler jobs (retries off: the next run catches up from the watermark)
gcloud scheduler jobs create http looker-diag-overall --location=$REGION --schedule="* * * * *" \
  --uri=$URI --http-method=POST --headers="Content-Type=application/json" \
  --message-body='{"job":"overall","groups":["overall"],"events":true,"windowMin":1}' \
  --oidc-service-account-email=$INVOKER_SA --oidc-token-audience=$URI --attempt-deadline=60s --max-retry-attempts=0
gcloud scheduler jobs create http looker-diag-detail --location=$REGION --schedule="*/5 * * * *" \
  --uri=$URI --http-method=POST --headers="Content-Type=application/json" \
  --message-body='{"job":"detail","groups":["queue","init","running","processing"],"events":false,"windowMin":5,"lateCheckMin":30}' \
  --oidc-service-account-email=$INVOKER_SA --oidc-token-audience=$URI --attempt-deadline=60s --max-retry-attempts=0
```

Confirm Cloud Run functions and Cloud Scheduler are available in `europe-west9` for your project before deploying.

## Verification in Dynatrace

```
// slow-query events
fetch events
| filter event.provider == "looker" and event.type == "looker.slow_query"
| dedup event.id
| sort timestamp desc
| fields timestamp, looker.instance, looker.model, looker.explore, looker.source, looker.query.id,
         looker.timing.async_processing, looker.timing.execute_main_query, db.query.text
| limit 50

// overall timing per minute, then jump to events with the same dimensions
timeseries { max = max(custom.gcp.looker.overall.async_processing.duration),
             avg = avg(custom.gcp.looker.overall.async_processing.duration) },
  by: { looker.model, looker.explore }, interval: 1m
```

```
// late rows (is LAG_SECONDS big enough?)
timeseries { rows = max(custom.gcp.looker.diag.late_rows), delay = max(custom.gcp.looker.diag.late_delay) }, interval: 5m
```

Check the run logs in Cloud Logging: `resource.type="cloud_run_revision" jsonPayload.message="run complete"` (fields `rows`, `linesSent`, `linesRejected`, `eventsSent`, `eventsRejected`, `retries`, `lookerMs`, `dtMs`, `durationMs`, trace-correlated).

## Behaviour

- **Windowing / idempotency**: a run reads closed minutes `[watermark, now − LAG)`. The watermark (one GCS object per job, written with `ifGenerationMatch`) advances only after Looker read and Dynatrace sends succeeded. A retry re-reads the same window. Metric points have deterministic timestamps and dimensions; events carry a deterministic `event.id` and are de-duplicated within a run. Dynatrace documents no ingest-side deduplication, so a crash between sending and the watermark write can resend a window: duplicates are possible in that case only; use `dedup event.id` in DQL.
- **Missed run**: the next run starts at the old watermark and catches up, at most `MAX_CATCHUP_MIN` (50 min, because Dynatrace accepts metric timestamps up to 1 h old). Older data is skipped and logged as a `watermark gap` warning. Scheduler retries are off.
- **Looker or Dynatrace down**: 3 attempts with jittered backoff (honours `Retry-After`, stops at the run deadline), then the run fails with HTTP 500 and the watermark stays. Auth errors (401/403) fail immediately. Dynatrace 400 (invalid lines/events) are logged with counts and examples and not retried.
- **Version**: before Looker 26.20 some metrics are not recorded for failed or retried queries, so `async_processing` can be much larger than the sum of its phases and metrics can be missing for those queries. Dashboards over such Looker versions are less complete.
- **Unverified in the docs** (check on first deployment): exact Looker field names and the API cache parameter (`cache=false`), Explore data lag (tune `LAG_SECONDS`), API row/rate limits, Dynatrace max lines per request, dimension value length/truncation, gauge value rules, whether a platform token is accepted by `/api/v2/metrics/ingest`, event field handling and event rate limits. Startup validation lists unknown Looker fields; fix them only in `catalog.json`.
- **Load on Looker**: System Activity is shared with the Looker application database. Use **Elite System Activity** (BigQuery-backed, paid for Looker original, included in Enterprise/Embed editions of core) or a read replica of the internal database to keep the 1-minute polling away from it.

## Security notes

- User names, emails and ids are never requested (explicit field allow-list) and are absent from metrics, events and logs.
- SQL is masked before it leaves the function: strings, numbers, hex, typed literals, IN lists, dollar/triple-quoted strings, placeholders and comments become `*` (double-quoted tokens too). If the SQL cannot be parsed (unterminated quote or comment, NUL, >200 kB) it is dropped and `looker.sql.masked=false`. Unmasked SQL is never logged.
- Secrets only from Secret Manager env mounts; log values are scrubbed and keys such as token/secret/sql are redacted. Tokens are never logged.
- URLs: https only, no credentials, no IP literals/localhost/`.internal`, Dynatrace host suffix allow-list, no redirects, URL path parts encoded. A public DNS name that resolves to a private address is a residual risk of operator-set URLs.
- The function is not publicly invokable (`--no-allow-unauthenticated`, OIDC invoker). Request bodies are validated.
- Residual risks: late-arriving Looker rows after a window closed are missed (measured by the late-row check; tune `LAG_SECONDS`); duplicate sends in the crash case above; masked SQL still exposes table and column names; with identical dimension values a batch hitting the one-minute row limit is truncated and logged (`truncated`).

## Dependencies

- Runtime: `@google-cloud/functions-framework`, the entrypoint contract for Cloud Run functions (also used for local runs). Everything else is native `fetch` (Looker, Dynatrace, GCS JSON API with the metadata-server token), hand-built line protocol and event JSON.
- Dev only: `typescript`, `@types/node`, `vitest`.

## Develop

```bash
npm install
npm test           # unit + integration (mocked Looker and Dynatrace HTTP)
npm run typecheck
```

Layout: `src/` (config, catalog, looker, aggregate, lineprotocol, events, mask, dynatrace, state, run, index), `tests/`, `catalog.json`, `dt_assets/` (empty, reserved for dashboards).
