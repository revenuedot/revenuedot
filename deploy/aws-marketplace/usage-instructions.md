# RevenueDot on AWS: usage instructions

These are the usage instructions for the AWS Marketplace listing (`product.yaml`). Full guide:
https://revenuedot.app/docs/guides/high-availability

RevenueDot runs as two or more replicas of one container behind a load balancer, on Amazon RDS for PostgreSQL 16 or
later. Every replica serves the SDK API, the REST API, store notifications and the dashboard on port 8787. Replicas
share all state through Postgres, so any replica can answer any request.

## Before you start
1. **A PostgreSQL 16+ database** reachable from the cluster: Amazon RDS Multi-AZ or Aurora PostgreSQL. Create a
   database and a user that owns it. Use a direct connection or RDS Proxy (not PgBouncer in transaction mode: the
   replicas use session advisory locks).
2. **A public host name** with a TLS certificate in ACM, e.g. `revenuedot.example.com`. SDKs, the App Store and Google
   Play reach RevenueDot there.
3. **An encryption key**: `openssl rand -base64 32`. It seals integration and export credentials in the database. Store
   it in AWS Secrets Manager and back it up: sealed credentials cannot be read without it.

## Helm chart on Amazon EKS
1. Create the two Secrets the chart reads:
   ```bash
   kubectl create namespace revenuedot
   kubectl -n revenuedot create secret generic revenuedot-db \
     --from-literal=DATABASE_URL='postgres://revenuedot:<password>@<rds-endpoint>:5432/revenuedot?sslmode=require'
   kubectl -n revenuedot create secret generic revenuedot-secrets \
     --from-literal=REVENUEDOT_ENCRYPTION_KEY='<key>' \
     --from-literal=REVENUEDOT_SMTP_URL='smtps://<user>:<password>@email-smtp.<region>.amazonaws.com:465'
   ```
   (Or sync them from Secrets Manager with the External Secrets Operator or the Secrets Store CSI driver.)
2. Install the chart from the listing's ECR repository:
   ```bash
   helm install revenuedot oci://<marketplace-ecr>/revenuedot/revenuedot --version 0.1.0 -n revenuedot \
     --set publicUrl=https://revenuedot.example.com \
     --set database.existingSecret=revenuedot-db \
     --set secrets.existingSecret=revenuedot-secrets \
     --set ingress.enabled=true --set ingress.className=alb \
     --set-string ingress.annotations."alb\.ingress\.kubernetes\.io/scheme"=internet-facing \
     --set-string ingress.annotations."alb\.ingress\.kubernetes\.io/target-type"=ip \
     --set-string ingress.annotations."alb\.ingress\.kubernetes\.io/healthcheck-path"=/readyz \
     --set-string ingress.annotations."alb\.ingress\.kubernetes\.io/certificate-arn"=<acm-certificate-arn> \
     --set ingress.hosts[0].host=revenuedot.example.com --set ingress.hosts[0].paths[0].path=/ \
     --set ingress.hosts[0].paths[0].pathType=Prefix
   ```
   A pre-install hook Job applies the database migrations once; then two to ten replicas start (autoscaled on CPU and
   memory, spread over Availability Zones, with a PodDisruptionBudget).
3. Check it: `kubectl -n revenuedot rollout status deploy/revenuedot && helm test revenuedot -n revenuedot`.
4. Point DNS for your host name at the load balancer, open `https://revenuedot.example.com/signup` and create the owner
   account. Only the owner can sign up; the owner invites the rest of the team.

## Container image on Amazon ECS
Use the Terraform reference setup in `deploy/terraform/aws` of https://github.com/revenuedot/revenuedot. It creates a
VPC across three zones, RDS PostgreSQL Multi-AZ, the ECS service on Fargate (two to ten tasks), an Application Load
Balancer with HTTPS, the ACM certificate, the secrets in Secrets Manager and CloudWatch alarms:

```bash
cd deploy/terraform/aws
cp terraform.tfvars.example terraform.tfvars   # set domain_name, route53_zone_id, alarm_email, and:
# image = "<marketplace-ecr>/revenuedot/revenuedot:0.1.0"
terraform init && terraform apply
```

Without Terraform, run the image with: port 8787; `DATABASE_URL` and `REVENUEDOT_ENCRYPTION_KEY` from Secrets Manager;
`REVENUEDOT_PUBLIC_URL=https://<your host>`; `REVENUEDOT_ARCHIVE_DIR=db`; user `1000:1000` with a read-only root
filesystem and a writable `/tmp`; the target group health check on `/readyz`; a container stop timeout of 30 seconds.

## Upgrades
Change the image tag (Helm: `helm upgrade … --version <new>`; Terraform: `image = …` and `terraform apply`). Migrations
run once (the Helm hook Job, or the first task under a Postgres lock), then replicas are replaced one at a time;
each old replica stops taking requests, finishes the ones in flight and exits.

## Operations
- Health: `GET /healthz` (process alive), `GET /readyz` (database reachable and not draining).
- Logs go to stdout; every replica logs its name. Alarms: 5xx rate, p95 latency, healthy targets, running tasks,
  database CPU, storage, memory and connections, and failed background job runs.
- Backups: RDS automated backups with point-in-time recovery (14 days in the Terraform setup).
- Support: Enterprise customers use their private Slack channel; everyone else emails hello@revenuedot.app.
