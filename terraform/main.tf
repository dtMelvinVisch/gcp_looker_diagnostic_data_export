locals {
  apis = [
    "run.googleapis.com", "cloudfunctions.googleapis.com", "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com", "secretmanager.googleapis.com", "cloudscheduler.googleapis.com",
    "storage.googleapis.com", "iam.googleapis.com",
  ]
  secrets = ["looker-client-id", "looker-client-secret", "dt-token"]
  # Same payloads the function validates in src/config.ts (parsePayload).
  jobs = {
    overall = { schedule = "* * * * *", body = { job = "overall", groups = ["overall"], events = true, windowMin = 1 } }
    detail = {
      schedule = "*/5 * * * *"
      body     = { job = "detail", groups = ["queue", "init", "running", "processing"], events = false, windowMin = 5, lateCheckMin = 30 }
    }
  }
}

resource "google_project_service" "api" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

# --- identities -------------------------------------------------------------
resource "google_service_account" "runtime" {
  account_id   = "looker-diag-runtime"
  display_name = "Looker diag runtime"
}

resource "google_service_account" "invoker" {
  account_id   = "looker-diag-invoker"
  display_name = "Looker diag scheduler invoker"
}

resource "google_service_account" "build" {
  account_id   = "looker-diag-build"
  display_name = "Looker diag Cloud Build"
}

resource "google_project_iam_member" "build" {
  for_each = toset(["roles/cloudbuild.builds.builder", "roles/logging.logWriter", "roles/artifactregistry.writer"])
  project  = var.project_id
  role     = each.value
  member   = google_service_account.build.member
}

# --- state bucket (watermarks) -----------------------------------------------
resource "google_storage_bucket" "state" {
  name                        = "${var.project_id}-looker-diag-state"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true # watermarks are disposable; lets `terraform destroy` finish
  depends_on                  = [google_project_service.api]
}

resource "google_storage_bucket_iam_member" "state" {
  bucket = google_storage_bucket.state.name
  role   = "roles/storage.objectUser"
  member = google_service_account.runtime.member
}

# --- secrets: created empty-ish, real values are added outside Terraform ------
resource "google_secret_manager_secret" "s" {
  for_each  = toset(local.secrets)
  secret_id = each.value
  replication {
    user_managed {
      replicas { location = var.region }
    }
  }
  depends_on = [google_project_service.api]
}

# Placeholder so the function can deploy; the real value is a newer version ("latest").
resource "google_secret_manager_secret_version" "placeholder" {
  for_each    = google_secret_manager_secret.s
  secret      = each.value.id
  secret_data = "REPLACE_ME"
  lifecycle { ignore_changes = [secret_data, enabled] }
}

resource "google_secret_manager_secret_iam_member" "runtime" {
  for_each  = google_secret_manager_secret.s
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.runtime.member
}

# --- function source (zip of this repo's runtime files) -----------------------
data "archive_file" "src" {
  type        = "zip"
  output_path = "${path.module}/.build/source.zip"
  dynamic "source" {
    for_each = toset(concat(
      ["package.json", "package-lock.json", "tsconfig.json", "catalog.json"],
      tolist(fileset(var.source_dir, "src/**")),
    ))
    content {
      content  = file("${var.source_dir}/${source.value}")
      filename = source.value
    }
  }
}

resource "google_storage_bucket" "source" {
  name                        = "${var.project_id}-looker-diag-source"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
  depends_on                  = [google_project_service.api]
}

resource "google_storage_bucket_object" "src" {
  name   = "source-${data.archive_file.src.output_md5}.zip"
  bucket = google_storage_bucket.source.name
  source = data.archive_file.src.output_path
}

resource "google_storage_bucket_iam_member" "build_reads_source" {
  bucket = google_storage_bucket.source.name
  role   = "roles/storage.objectViewer"
  member = google_service_account.build.member
}

# --- function ---------------------------------------------------------------
resource "google_cloudfunctions2_function" "diag" {
  name     = "looker-diag"
  location = var.region

  build_config {
    runtime         = "nodejs22"
    entry_point     = "lookerDiag"
    service_account = google_service_account.build.id
    source {
      storage_source {
        bucket = google_storage_bucket.source.name
        object = google_storage_bucket_object.src.name
      }
    }
  }

  service_config {
    service_account_email          = google_service_account.runtime.email
    available_memory               = "256Mi"
    timeout_seconds                = 55
    max_instance_count             = 2
    ingress_settings               = "ALLOW_ALL" # still IAM-protected: only the invoker SA may call it
    all_traffic_on_latest_revision = true

    environment_variables = {
      LOOKER_BASE_URL        = var.looker_base_url
      LOOKER_DEPLOYMENT      = var.looker_deployment
      LOOKER_VERSION         = var.looker_version
      LOOKER_INSTANCE        = var.looker_instance
      DT_ENV_URL             = var.dt_env_url
      REGION                 = var.region
      GCP_PROJECT_ID         = var.project_id
      STATE_BUCKET           = google_storage_bucket.state.name
      SLOW_QUERY_THRESHOLD_S = tostring(var.slow_query_threshold_s)
    }

    dynamic "secret_environment_variables" {
      for_each = {
        LOOKER_CLIENT_ID     = "looker-client-id"
        LOOKER_CLIENT_SECRET = "looker-client-secret"
        DT_TOKEN             = "dt-token"
      }
      content {
        key        = secret_environment_variables.key
        project_id = var.project_id
        secret     = secret_environment_variables.value
        version    = "latest"
      }
    }
  }

  depends_on = [
    google_project_service.api,
    google_project_iam_member.build,
    google_storage_bucket_iam_member.build_reads_source,
    google_secret_manager_secret_iam_member.runtime,
    google_secret_manager_secret_version.placeholder,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "invoker" {
  location = var.region
  name     = google_cloudfunctions2_function.diag.name
  role     = "roles/run.invoker"
  member   = google_service_account.invoker.member
}

# --- schedules (retries off: the next run catches up from the watermark) -------
resource "google_cloud_scheduler_job" "job" {
  for_each         = local.jobs
  name             = "looker-diag-${each.key}"
  region           = var.region
  schedule         = each.value.schedule
  paused           = !var.schedulers_enabled
  attempt_deadline = "60s"

  retry_config { retry_count = 0 }

  http_target {
    uri         = google_cloudfunctions2_function.diag.service_config[0].uri
    http_method = "POST"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode(each.value.body))
    oidc_token {
      service_account_email = google_service_account.invoker.email
      audience              = google_cloudfunctions2_function.diag.service_config[0].uri
    }
  }

  depends_on = [google_project_service.api, google_cloud_run_v2_service_iam_member.invoker]
}
