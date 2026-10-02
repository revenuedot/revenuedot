# Alarms go to one SNS topic; subscribe email (alarm_email), PagerDuty or Opsgenie to it.
resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = aws_kms_key.main.id
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alb_dimensions = { LoadBalancer = aws_lb.main.arn_suffix }
  tg_dimensions  = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.app.arn_suffix }
  db_dimensions  = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  alarm_actions  = [aws_sns_topic.alarms.arn]
}

# The purchase path is failing: 5xx answers from the tasks or the load balancer.
resource "aws_cloudwatch_metric_alarm" "http_5xx" {
  alarm_name          = "${var.name}-5xx"
  alarm_description   = "More than 1% of requests answered 5xx for 5 minutes. SDK receipt posts retry on 5xx, but purchases are delayed."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
  metric_query {
    id          = "rate"
    expression  = "IF(FILL(req, 0) > 0, 100 * (FILL(t5xx, 0) + FILL(e5xx, 0)) / FILL(req, 0), 0)"
    label       = "5xx percent"
    return_data = true
  }
  metric_query {
    id = "t5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      dimensions  = local.alb_dimensions
      period      = 60
      stat        = "Sum"
    }
  }
  metric_query {
    id = "e5xx"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      dimensions  = local.alb_dimensions
      period      = 60
      stat        = "Sum"
    }
  }
  metric_query {
    id = "req"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      dimensions  = local.alb_dimensions
      period      = 60
      stat        = "Sum"
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "latency" {
  alarm_name          = "${var.name}-latency-p95"
  alarm_description   = "95th percentile response time above 2 seconds for 10 minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  dimensions          = local.alb_dimensions
  extended_statistic  = "p95"
  period              = 60
  evaluation_periods  = 10
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "healthy_hosts" {
  alarm_name          = "${var.name}-healthy-tasks"
  alarm_description   = "Fewer ready tasks behind the load balancer than min_tasks for 3 minutes: one more failure is an outage."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = local.tg_dimensions
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = var.min_tasks
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "running_tasks" {
  alarm_name          = "${var.name}-running-tasks"
  alarm_description   = "Fewer running tasks than min_tasks for 5 minutes (Container Insights)."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.app.name }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.min_tasks
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${var.name}-db-cpu"
  alarm_description   = "Database CPU above 80% for 15 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = local.db_dimensions
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${var.name}-db-free-storage"
  alarm_description   = "Less than 10 GiB of database storage left (storage autoscaling stops at db_max_allocated_storage)."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = local.db_dimensions
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10 * 1024 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "db_memory" {
  alarm_name          = "${var.name}-db-freeable-memory"
  alarm_description   = "Less than 256 MiB of database memory free for 15 minutes."
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  dimensions          = local.db_dimensions
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 256 * 1024 * 1024
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "db_connections" {
  alarm_name          = "${var.name}-db-connections"
  alarm_description   = "Database connections near the pool total (max_tasks x db_pool_max): raise max_connections or lower the pool."
  namespace           = "AWS/RDS"
  metric_name         = "DatabaseConnections"
  dimensions          = local.db_dimensions
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 2
  threshold           = floor(0.9 * var.max_tasks * var.db_pool_max)
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# The background job (expirations, webhooks, alerts, exports) logs "tick failed" when a run throws.
resource "aws_cloudwatch_log_metric_filter" "tick_failed" {
  name           = "${var.name}-tick-failed"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "\"tick failed\""
  metric_transformation {
    name          = "TickFailed"
    namespace     = "RevenueDot/${var.name}"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "tick_failed" {
  alarm_name          = "${var.name}-background-job-failing"
  alarm_description   = "The background job failed 3 times in 15 minutes: webhooks, expirations and alert emails may be late."
  namespace           = "RevenueDot/${var.name}"
  metric_name         = "TickFailed"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
