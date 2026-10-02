# RevenueDot on Google Cloud: Cloud Run (2 to 10 instances) on Cloud SQL for PostgreSQL with regional high availability,
# Secret Manager and Cloud Monitoring alerts. Reference setup for prd/ha-self-host/PRD.md;
# guide: https://revenuedot.app/docs/guides/high-availability
#
#   cp terraform.tfvars.example terraform.tfvars   # then edit
#   terraform init && terraform plan
#
# State holds the database password and the encryption key: keep it in an encrypted, access-controlled backend, e.g.
#   terraform { backend "gcs" { bucket = "…" prefix = "revenuedot" } }
terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.10, < 8.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
