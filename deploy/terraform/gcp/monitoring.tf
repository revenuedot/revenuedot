resource "google_monitoring_notification_channel" "email" {
  count        = var.alert_email == "" ? 0 : 1
  display_name = "${var.name} alerts"
  type         = "email"
  labels       = { email_address = var.alert_email }
}

locals {
  channels   = google_monitoring_notification_channel.email[*].id
  run_filter = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${google_cloud_run_v2_service.app.name}\""
  sql_filter = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${var.project_id}:${google_sql_database_instance.main.name}\""
}

# The SLA's measure: an outside check of the public address every minute from several regions.
resource "google_monitoring_uptime_check_config" "readyz" {
  display_name = "${var.name} /readyz"
  timeout      = "10s"
  period       = "60s"
  http_check {
    path         = "/readyz"
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }
  monitored_resource {
    type   = "uptime_url"
    labels = { project_id = var.project_id, host = local.public_host }
  }
}

resource "google_monitoring_alert_policy" "uptime" {
  display_name          = "${var.name}: /readyz failing"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "Uptime check failing from 2 or more regions"
    condition_threshold {
      filter          = "metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type = \"uptime_url\" AND metric.labels.check_id = \"${google_monitoring_uptime_check_config.readyz.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "120s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "errors" {
  display_name          = "${var.name}: 5xx answers"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "More than 1 answer a second is 5xx for 5 minutes"
    condition_threshold {
      filter          = "${local.run_filter} AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "300s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "latency" {
  display_name          = "${var.name}: slow answers"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "95th percentile latency above 2 seconds for 10 minutes"
    condition_threshold {
      filter          = "${local.run_filter} AND metric.type = \"run.googleapis.com/request_latencies\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2000
      duration        = "600s"
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MAX"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "db" {
  display_name          = "${var.name}: database under pressure"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "CPU above 80% for 15 minutes"
    condition_threshold {
      filter          = "${local.sql_filter} AND metric.type = \"cloudsql.googleapis.com/database/cpu/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "900s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  conditions {
    display_name = "Disk above 85% full"
    condition_threshold {
      filter          = "${local.sql_filter} AND metric.type = \"cloudsql.googleapis.com/database/disk/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      duration        = "300s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }
}

# The background job (expirations, webhooks, alerts, exports) logs "tick failed" when a run throws.
resource "google_logging_metric" "tick_failed" {
  name   = "${var.name}-tick-failed"
  filter = "${local.run_filter} AND textPayload:\"tick failed\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
}

resource "google_monitoring_alert_policy" "tick_failed" {
  display_name          = "${var.name}: background job failing"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "3 or more failed runs in 15 minutes"
    condition_threshold {
      filter          = "metric.type = \"logging.googleapis.com/user/${google_logging_metric.tick_failed.name}\" AND resource.type = \"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 2
      duration        = "0s"
      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}
