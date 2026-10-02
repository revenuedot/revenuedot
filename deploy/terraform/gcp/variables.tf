variable "project_id" {
  description = "Google Cloud project."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run and Cloud SQL."
  type        = string
  default     = "us-central1"
}

variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "revenuedot"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.name))
    error_message = "Use 2 to 21 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "image" {
  description = "RevenueDot container image in Artifact Registry, e.g. us-central1-docker.pkg.dev/my-project/revenuedot/revenuedot:0.1.0."
  type        = string
}

variable "public_url" {
  description = "Public address (a custom domain mapped to the service, or a load balancer). Empty uses the service's run.app address."
  type        = string
  default     = ""
}

variable "min_instances" {
  description = "Fewest instances. At least 2: Cloud Run spreads them over zones."
  type        = number
  default     = 2
  validation {
    condition     = var.min_instances >= 2
    error_message = "min_instances must be at least 2 for high availability."
  }
}

variable "max_instances" {
  description = "Most instances under load."
  type        = number
  default     = 10
}

variable "cpu" {
  description = "vCPUs per instance."
  type        = string
  default     = "1"
}

variable "memory" {
  description = "Memory per instance."
  type        = string
  default     = "1Gi"
}

variable "concurrency" {
  description = "Requests one instance handles at once."
  type        = number
  default     = 80
}

variable "db_tier" {
  description = "Cloud SQL machine type."
  type        = string
  default     = "db-custom-2-7680"
}

variable "db_version" {
  description = "Cloud SQL database version."
  type        = string
  default     = "POSTGRES_16"
}

variable "db_disk_size_gb" {
  description = "Initial disk size; it grows on its own."
  type        = number
  default     = 50
}

variable "db_deletion_protection" {
  description = "Refuse to delete the database (turn off only to tear down a test stack)."
  type        = bool
  default     = true
}

variable "db_pool_max" {
  description = "Connections per instance. max_instances x pool must stay well under the database's max_connections."
  type        = number
  default     = 10
}

variable "network_cidr" {
  description = "Subnet range for Cloud Run's direct VPC egress."
  type        = string
  default     = "10.50.0.0/24"
}

variable "allow_signup" {
  description = "Let anyone sign up. When false, only the first account (the owner) can, and the owner invites the rest."
  type        = bool
  default     = false
}

variable "environment" {
  description = "Extra plain environment variables (see .env.example), e.g. REVENUEDOT_MAIL_FROM."
  type        = map(string)
  default     = {}
}

variable "secret_ids" {
  description = "Extra secrets as environment variable name => Secret Manager secret id in this project, e.g. REVENUEDOT_SMTP_URL, REVENUEDOT_SIGNING_KEY, REVENUEDOT_LICENSE_KEY."
  type        = map(string)
  default     = {}
}

variable "alert_email" {
  description = "Email address for alerts. Empty: add your own notification channels to the policies."
  type        = string
  default     = ""
}
