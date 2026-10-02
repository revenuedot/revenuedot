data "google_project" "this" {
  project_id = var.project_id
}

locals {
  apis = ["run.googleapis.com", "sqladmin.googleapis.com", "secretmanager.googleapis.com", "servicenetworking.googleapis.com", "compute.googleapis.com", "monitoring.googleapis.com", "logging.googleapis.com"]
  # Cloud Run's deterministic address, used when no custom domain is set.
  run_url     = "https://${var.name}-${data.google_project.this.number}.${var.region}.run.app"
  public_url  = trimsuffix(var.public_url != "" ? var.public_url : local.run_url, "/")
  public_host = split("/", local.public_url)[2]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

# ---------- Network: Cloud SQL on a private IP, reached by Cloud Run through direct VPC egress ----------
resource "google_compute_network" "main" {
  name                    = var.name
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "run" {
  name                     = "${var.name}-run"
  network                  = google_compute_network.main.id
  region                   = var.region
  ip_cidr_range            = var.network_cidr
  private_ip_google_access = true
}

resource "google_compute_global_address" "sql" {
  name          = "${var.name}-sql"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "sql" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql.name]
}

# ---------- Cloud SQL for PostgreSQL, regional (a standby in a second zone, automatic failover) ----------
resource "random_password" "db" {
  length  = 40
  special = false
}

resource "google_sql_database_instance" "main" {
  name                = var.name
  database_version    = var.db_version
  region              = var.region
  deletion_protection = var.db_deletion_protection
  settings {
    tier                        = var.db_tier
    edition                     = "ENTERPRISE"
    availability_type           = "REGIONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = var.db_disk_size_gb
    disk_autoresize             = true
    deletion_protection_enabled = var.db_deletion_protection
    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.main.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 14
      }
    }
    maintenance_window {
      day          = 7
      hour         = 4
      update_track = "stable"
    }
    insights_config {
      query_insights_enabled = true
    }
    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }
  }
  depends_on = [google_service_networking_connection.sql]
}

resource "google_sql_database" "main" {
  name     = "revenuedot"
  instance = google_sql_database_instance.main.name
}

resource "google_sql_user" "main" {
  name     = "revenuedot"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}

# ---------- Secrets ----------
resource "random_id" "encryption_key" {
  byte_length = 32
}

locals {
  own_secrets = {
    DATABASE_URL              = "postgres://${google_sql_user.main.name}:${random_password.db.result}@${google_sql_database_instance.main.private_ip_address}:5432/${google_sql_database.main.name}?sslmode=require"
    REVENUEDOT_ENCRYPTION_KEY = random_id.encryption_key.b64_std
  }
}

resource "google_secret_manager_secret" "own" {
  for_each  = toset(keys(local.own_secrets))
  secret_id = "${var.name}-${lower(replace(each.value, "_", "-"))}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "own" {
  for_each    = google_secret_manager_secret.own
  secret      = each.value.id
  secret_data = local.own_secrets[each.key]
}

resource "google_service_account" "run" {
  account_id   = "${var.name}-run"
  display_name = "RevenueDot on Cloud Run"
}

resource "google_secret_manager_secret_iam_member" "own" {
  for_each  = google_secret_manager_secret.own
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

resource "google_secret_manager_secret_iam_member" "extra" {
  for_each  = var.secret_ids
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

locals {
  env = merge({
    NODE_ENV                = "production"
    REVENUEDOT_PUBLIC_URL   = local.public_url
    REVENUEDOT_ALLOW_SIGNUP = tostring(var.allow_signup)
    REVENUEDOT_ARCHIVE_DIR  = "db"
    DATABASE_POOL_MAX       = tostring(var.db_pool_max)
    # Cloud Run stops routing to an instance before SIGTERM and kills it 10 seconds later.
    REVENUEDOT_SHUTDOWN_DELAY_MS   = "0"
    REVENUEDOT_SHUTDOWN_TIMEOUT_MS = "8000"
  }, var.environment)
  secret_env = merge({ for k, s in google_secret_manager_secret.own : k => s.secret_id }, var.secret_ids)
}

# ---------- Cloud Run ----------
resource "google_cloud_run_v2_service" "app" {
  name                = var.name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false
  template {
    service_account                  = google_service_account.run.email
    max_instance_request_concurrency = var.concurrency
    timeout                          = "300s"
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.main.id
        subnetwork = google_compute_subnetwork.run.id
      }
    }
    containers {
      image = var.image
      ports {
        container_port = 8787
      }
      resources {
        limits = { cpu = var.cpu, memory = var.memory }
        # CPU stays on between requests: the background job runs on an interval.
        cpu_idle          = false
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = local.env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 5
        failure_threshold = 60
        timeout_seconds   = 3
      }
      liveness_probe {
        http_get {
          path = "/healthz"
        }
        period_seconds    = 15
        failure_threshold = 3
        timeout_seconds   = 3
      }
    }
  }
  depends_on = [google_secret_manager_secret_version.own, google_secret_manager_secret_iam_member.own, google_secret_manager_secret_iam_member.extra]
}

# SDKs, store notifications and browsers call it without Google credentials.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.app.name
  location = google_cloud_run_v2_service.app.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Migrations as a job: gcloud run jobs execute <name>-migrate --region <region> --wait (each instance also migrates on
# start under a Postgres lock, so running it is optional).
resource "google_cloud_run_v2_job" "migrate" {
  name                = "${var.name}-migrate"
  location            = var.region
  deletion_protection = false
  template {
    task_count = 1
    template {
      service_account = google_service_account.run.email
      max_retries     = 1
      timeout         = "900s"
      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.main.id
          subnetwork = google_compute_subnetwork.run.id
        }
      }
      containers {
        image   = var.image
        command = ["node", "--import", "tsx", "src/migrate.node.ts"]
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.own["DATABASE_URL"].secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_version.own, google_secret_manager_secret_iam_member.own]
}
