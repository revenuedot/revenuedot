resource "random_password" "db" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.database[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = "${var.name}-pg${split(".", var.db_engine_version)[0]}"
  family = "postgres${split(".", var.db_engine_version)[0]}"
  # Every connection is TLS.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  # Slow statements (over 1 s) in the database log.
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_iam_role" "rds_monitoring" {
  name = "${var.name}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "monitoring.rds.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# Multi-AZ: a synchronous standby in another zone; RDS fails over in about a minute and the endpoint name stays the same.
# The servers reconnect on their own (the pool replaces broken connections); requests that need the database answer 5xx
# until then, and the SDKs retry receipts that got a 5xx.
resource "aws_db_instance" "main" {
  identifier                            = var.name
  engine                                = "postgres"
  engine_version                        = var.db_engine_version
  instance_class                        = var.db_instance_class
  allocated_storage                     = var.db_allocated_storage
  max_allocated_storage                 = var.db_max_allocated_storage
  storage_type                          = "gp3"
  storage_encrypted                     = true
  kms_key_id                            = aws_kms_key.main.arn
  db_name                               = "revenuedot"
  username                              = "revenuedot"
  password                              = random_password.db.result
  port                                  = 5432
  multi_az                              = true
  db_subnet_group_name                  = aws_db_subnet_group.main.name
  vpc_security_group_ids                = [aws_security_group.db.id]
  parameter_group_name                  = aws_db_parameter_group.main.name
  publicly_accessible                   = false
  backup_retention_period               = var.db_backup_retention_days
  backup_window                         = "03:00-04:00"
  maintenance_window                    = "sun:04:30-sun:05:30"
  copy_tags_to_snapshot                 = true
  deletion_protection                   = var.db_deletion_protection
  skip_final_snapshot                   = false
  final_snapshot_identifier             = "${var.name}-final"
  auto_minor_version_upgrade            = true
  allow_major_version_upgrade           = false
  apply_immediately                     = false
  performance_insights_enabled          = true
  performance_insights_kms_key_id       = aws_kms_key.main.arn
  performance_insights_retention_period = 7
  monitoring_interval                   = 60
  monitoring_role_arn                   = aws_iam_role.rds_monitoring.arn
  enabled_cloudwatch_logs_exports       = ["postgresql", "upgrade"]
  ca_cert_identifier                    = "rds-ca-rsa2048-g1"
  # Enhanced monitoring needs the role's policy in place, or the first create can fail while IAM catches up.
  depends_on = [aws_iam_role_policy_attachment.rds_monitoring]
}
