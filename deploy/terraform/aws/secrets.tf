# The server reads these at start (ECS injects them as environment variables). Rotate the database password by changing
# random_password.db (taint it) and applying: the URL secret is rewritten and a new deployment picks it up.
resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.name}/database-url"
  description             = "Postgres URL for RevenueDot (TLS required)"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgres://${aws_db_instance.main.username}:${random_password.db.result}@${aws_db_instance.main.endpoint}/${aws_db_instance.main.db_name}?sslmode=require"
}

# Seals integration and export credentials at rest. Keep it: data sealed with it cannot be read without it.
resource "random_id" "encryption_key" {
  byte_length = 32
}

resource "aws_secretsmanager_secret" "encryption_key" {
  name                    = "${var.name}/encryption-key"
  description             = "REVENUEDOT_ENCRYPTION_KEY (base64 of 32 random bytes)"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "encryption_key" {
  secret_id     = aws_secretsmanager_secret.encryption_key.id
  secret_string = random_id.encryption_key.b64_std
}
