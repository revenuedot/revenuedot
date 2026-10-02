resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.name}/server"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.main.arn
}

resource "aws_ecs_cluster" "main" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE"]
  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

# Pulls the image, writes logs and reads the secrets at task start.
resource "aws_iam_role" "execution" {
  name = "${var.name}-task-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = concat([aws_secretsmanager_secret.database_url.arn, aws_secretsmanager_secret.encryption_key.arn], values(var.secret_arns))
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.main.arn]
      },
    ]
  })
}

# The server itself calls no AWS API; the task role exists so you can attach policies later without a new task definition.
resource "aws_iam_role" "task" {
  name = "${var.name}-task"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

locals {
  public_url = "https://${var.domain_name}"
  base_environment = merge({
    PORT                           = "8787"
    NODE_ENV                       = "production"
    REVENUEDOT_PUBLIC_URL          = local.public_url
    REVENUEDOT_ALLOW_SIGNUP        = tostring(var.allow_signup)
    REVENUEDOT_ARCHIVE_DIR         = "db"
    DATABASE_POOL_MAX              = tostring(var.db_pool_max)
    REVENUEDOT_SHUTDOWN_DELAY_MS   = "5000"
    REVENUEDOT_SHUTDOWN_TIMEOUT_MS = "20000"
  }, var.environment)
  secrets = merge({
    DATABASE_URL              = aws_secretsmanager_secret.database_url.arn
    REVENUEDOT_ENCRYPTION_KEY = aws_secretsmanager_secret.encryption_key.arn
  }, var.secret_arns)
  log_options = {
    awslogs-group         = aws_cloudwatch_log_group.app.name
    awslogs-region        = var.region
    awslogs-stream-prefix = "server"
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
  volume {
    name = "tmp"
  }
  container_definitions = jsonencode([{
    name                   = "revenuedot"
    image                  = var.image
    essential              = true
    readonlyRootFilesystem = true
    user                   = "1000:1000"
    portMappings           = [{ containerPort = 8787, protocol = "tcp", name = "http" }]
    environment            = [for k, v in merge(local.base_environment, { REVENUEDOT_MIGRATE = var.migrate_on_start ? "auto" : "skip" }) : { name = k, value = v }]
    secrets                = [for k, v in local.secrets : { name = k, valueFrom = v }]
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    # ECS sends SIGTERM, then SIGKILL after stopTimeout: the server drains in the 5 + 20 seconds set above.
    stopTimeout = 30
    healthCheck = {
      command  = ["CMD", "node", "-e", "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval = 15
      timeout  = 5
      retries  = 3
      # Room for a long migration on start (the most ECS allows).
      startPeriod = 300
    }
    logConfiguration = { logDriver = "awslogs", options = local.log_options }
  }])
}

# Migrations as a one-off task, for migrate_on_start = false: run it before each deploy (outputs.migrate_command).
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
  volume {
    name = "tmp"
  }
  container_definitions = jsonencode([{
    name                   = "migrate"
    image                  = var.image
    essential              = true
    readonlyRootFilesystem = true
    user                   = "1000:1000"
    command                = ["node", "--import", "tsx", "src/migrate.node.ts"]
    secrets                = [{ name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn }]
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    logConfiguration       = { logDriver = "awslogs", options = merge(local.log_options, { awslogs-stream-prefix = "migrate" }) }
  }])
}

resource "aws_ecs_service" "app" {
  name                               = var.name
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.app.arn
  desired_count                      = var.min_tasks
  launch_type                        = "FARGATE"
  platform_version                   = "LATEST"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = 120
  propagate_tags                     = "SERVICE"
  enable_ecs_managed_tags            = true
  wait_for_steady_state              = false
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "revenuedot"
    container_port   = 8787
  }
  # The autoscaler owns the count after creation.
  lifecycle {
    ignore_changes = [desired_count]
  }
  depends_on = [aws_lb_listener.https]
}

resource "aws_appautoscaling_target" "app" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.min_tasks
  max_capacity       = var.max_tasks
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name}-cpu"
  service_namespace  = aws_appautoscaling_target.app.service_namespace
  resource_id        = aws_appautoscaling_target.app.resource_id
  scalable_dimension = aws_appautoscaling_target.app.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_percent
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
