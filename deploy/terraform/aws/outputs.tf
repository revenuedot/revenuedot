output "url" {
  description = "Where RevenueDot answers. Point the SDKs' proxy URL and the store notification URLs here."
  value       = local.public_url
}

output "load_balancer_dns_name" {
  description = "Load balancer host name (for a CNAME when DNS is not in Route 53)."
  value       = aws_lb.main.dns_name
}

output "certificate_validation_records" {
  description = "DNS records that validate a new certificate (created for you when route53_zone_id is set)."
  value       = local.create_certificate ? aws_acm_certificate.main[0].domain_validation_options : []
}

output "database_endpoint" {
  description = "RDS endpoint (private)."
  value       = aws_db_instance.main.endpoint
}

output "database_url_secret_arn" {
  description = "Secrets Manager secret holding DATABASE_URL."
  value       = aws_secretsmanager_secret.database_url.arn
}

output "encryption_key_secret_arn" {
  description = "Secrets Manager secret holding REVENUEDOT_ENCRYPTION_KEY. Back it up: sealed credentials cannot be read without it."
  value       = aws_secretsmanager_secret.encryption_key.arn
}

output "ecs_cluster" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service" {
  description = "ECS service name (aws ecs update-service --force-new-deployment to roll it)."
  value       = aws_ecs_service.app.name
}

output "alarm_topic_arn" {
  description = "SNS topic every alarm notifies."
  value       = aws_sns_topic.alarms.arn
}

output "migrate_command" {
  description = "Runs the migrations once and waits for them (for migrate_on_start = false, before the service moves to a new image)."
  value = join(" && ", [
    "task=$(aws ecs run-task --region ${var.region} --cluster ${aws_ecs_cluster.main.name} --launch-type FARGATE --task-definition ${aws_ecs_task_definition.migrate.family} --network-configuration 'awsvpcConfiguration={subnets=[${join(",", aws_subnet.private[*].id)}],securityGroups=[${aws_security_group.app.id}],assignPublicIp=DISABLED}' --query 'tasks[0].taskArn' --output text)",
    "aws ecs wait tasks-stopped --region ${var.region} --cluster ${aws_ecs_cluster.main.name} --tasks \"$task\"",
    "test \"$(aws ecs describe-tasks --region ${var.region} --cluster ${aws_ecs_cluster.main.name} --tasks \"$task\" --query 'tasks[0].containers[0].exitCode' --output text)\" = 0",
  ])
}
