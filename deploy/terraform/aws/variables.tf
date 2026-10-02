variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "revenuedot"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.name))
    error_message = "Use 2 to 21 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "tags" {
  description = "Extra tags on every resource."
  type        = map(string)
  default     = {}
}

variable "domain_name" {
  description = "Public host name, e.g. revenuedot.example.com. People, SDKs and the stores reach RevenueDot here."
  type        = string
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone for domain_name: validates the certificate and points the name at the load balancer. Leave empty and set certificate_arn to manage DNS yourself."
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = "An existing ACM certificate for domain_name in this region. Used instead of a new one when set."
  type        = string
  default     = ""
}

variable "image" {
  description = "RevenueDot container image (ECR or another registry), e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/revenuedot:0.1.0."
  type        = string
}

variable "cpu_architecture" {
  description = "X86_64 or ARM64, matching the image."
  type        = string
  default     = "X86_64"
  validation {
    condition     = contains(["X86_64", "ARM64"], var.cpu_architecture)
    error_message = "cpu_architecture must be X86_64 or ARM64."
  }
}

variable "vpc_cidr" {
  description = "VPC address range. Split into public, private and database subnets in each zone."
  type        = string
  default     = "10.40.0.0/16"
}

variable "az_count" {
  description = "Availability zones to use (2 or 3)."
  type        = number
  default     = 3
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "single_nat_gateway" {
  description = "One NAT gateway instead of one per zone: cheaper, but outbound calls (stores, webhooks) stop if its zone fails."
  type        = bool
  default     = false
}

variable "task_cpu" {
  description = "Fargate task CPU units (1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "task_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 2048
}

variable "min_tasks" {
  description = "Fewest running tasks. At least 2, spread over zones."
  type        = number
  default     = 2
  validation {
    condition     = var.min_tasks >= 2
    error_message = "min_tasks must be at least 2 for high availability."
  }
}

variable "max_tasks" {
  description = "Most running tasks under load."
  type        = number
  default     = 10
}

variable "cpu_target_percent" {
  description = "Average CPU the service scales to keep."
  type        = number
  default     = 60
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.m7g.large"
}

variable "db_engine_version" {
  description = "PostgreSQL major version (16 or later)."
  type        = string
  default     = "16"
}

variable "db_allocated_storage" {
  description = "Initial storage in GiB."
  type        = number
  default     = 50
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling in GiB."
  type        = number
  default     = 500
}

variable "db_backup_retention_days" {
  description = "Automated backup and point-in-time recovery window in days."
  type        = number
  default     = 14
}

variable "db_deletion_protection" {
  description = "Refuse to delete the database (turn off only to tear down a test stack)."
  type        = bool
  default     = true
}

variable "db_pool_max" {
  description = "Connections per task. Tasks x pool must stay well under the instance's max_connections."
  type        = number
  default     = 10
}

variable "migrate_on_start" {
  description = "Each task migrates on start under a Postgres lock. Set false to run the migration task yourself before each deploy (see outputs)."
  type        = bool
  default     = true
}

variable "allow_signup" {
  description = "Let anyone sign up. When false, only the first account (the owner) can, and the owner invites the rest."
  type        = bool
  default     = false
}

variable "environment" {
  description = "Extra plain environment variables for the server (see .env.example), e.g. REVENUEDOT_MAIL_FROM."
  type        = map(string)
  default     = {}
}

variable "secret_arns" {
  description = "Extra secrets as environment variable name => Secrets Manager ARN, e.g. REVENUEDOT_SMTP_URL, REVENUEDOT_SIGNING_KEY, REVENUEDOT_LICENSE_KEY, ANTHROPIC_API_KEY."
  type        = map(string)
  default     = {}
}

variable "alarm_email" {
  description = "Email address subscribed to the alarm topic. Empty: subscribe your pager to the topic yourself."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}

variable "alb_deletion_protection" {
  description = "Refuse to delete the load balancer."
  type        = bool
  default     = true
}
