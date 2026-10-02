output "url" {
  description = "Where RevenueDot answers. Point the SDKs' proxy URL and the store notification URLs here."
  value       = local.public_url
}

output "service_uri" {
  description = "Cloud Run's own address for the service."
  value       = google_cloud_run_v2_service.app.uri
}

output "database_instance" {
  description = "Cloud SQL instance connection name."
  value       = google_sql_database_instance.main.connection_name
}

output "encryption_key_secret" {
  description = "Secret Manager secret holding REVENUEDOT_ENCRYPTION_KEY. Back it up: sealed credentials cannot be read without it."
  value       = google_secret_manager_secret.own["REVENUEDOT_ENCRYPTION_KEY"].secret_id
}

output "migrate_command" {
  description = "Runs the migrations once (optional: instances also migrate on start under a lock)."
  value       = "gcloud run jobs execute ${google_cloud_run_v2_job.migrate.name} --region ${var.region} --project ${var.project_id} --wait"
}
