variable "project_id" {
  type        = string
  description = "GCP project to deploy into."
}

variable "region" {
  type        = string
  description = "Region for the function, scheduler and buckets; also the gcp.region dimension (e.g. europe-west9)."
}

variable "looker_base_url" {
  type        = string
  description = "Looker origin, https only, e.g. https://acme.cloud.looker.com."
}

variable "looker_instance" {
  type        = string
  description = "Name used in the looker.instance dimension."
}

variable "dt_env_url" {
  type        = string
  description = "Dynatrace environment URL, e.g. https://abc12345.live.dynatrace.com."
}

variable "looker_deployment" {
  type        = string
  default     = "core"
  description = "'core' (Looker Google Cloud core) or 'original'."
}

variable "looker_version" {
  type        = string
  default     = ""
  description = "Looker version such as 26.20. Below 26.20 or empty only adds a caveat flag to run logs."
}

variable "slow_query_threshold_s" {
  type        = number
  default     = 30
  description = "Queries whose slow-query field exceeds this many seconds become Dynatrace events."
}

variable "schedulers_enabled" {
  type        = bool
  default     = false
  description = "Keep false for the first apply; set true after the three secret values are added."
}

variable "source_dir" {
  type        = string
  default     = ".."
  description = "Repository root holding src/, package.json, catalog.json."
}
