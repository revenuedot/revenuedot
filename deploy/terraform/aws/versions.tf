# RevenueDot on AWS: ECS Fargate behind an Application Load Balancer, RDS PostgreSQL Multi-AZ, Secrets Manager and
# CloudWatch alarms. Reference setup for prd/ha-self-host/PRD.md; guide: https://revenuedot.app/docs/guides/high-availability
#
#   cp terraform.tfvars.example terraform.tfvars   # then edit
#   terraform init && terraform plan
#
# State holds the database password and the encryption key: keep it in an encrypted, access-controlled backend, e.g.
#   terraform { backend "s3" { bucket = "…" key = "revenuedot/terraform.tfstate" region = "…" encrypt = true use_lockfile = true } }
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.70, < 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = merge({ Application = "revenuedot", ManagedBy = "terraform" }, var.tags)
  }
}
