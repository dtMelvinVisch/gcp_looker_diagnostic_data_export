output "function_uri" {
  value = google_cloudfunctions2_function.diag.service_config[0].uri
}

