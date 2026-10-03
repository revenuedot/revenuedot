# High-availability self-host (Tier 3)

**Status:** built on branch `tier3-ha`. The Node server runs as several replicas behind a load balancer against one Postgres: migrations run once under a Postgres advisory lock, the background job runs on one replica at a time, webhook deliveries, expirations and alert emails are claimed row by row, `/healthz` and `/readyz` answer, and SIGTERM drains. A 3-replica run on one Railway development database (`scripts/e2e/cluster/run.ts`, results in `cluster-results.json`) passed 24 of 24 checks: 300 purchases, one replica stopped mid-load (exited 0 in 1.5 s), each of 340 events delivered exactly once, one alert email. A two-replica browser run (`scripts/e2e/cluster/browser-stack.ts`) signed up, made a webhook, a Test Store product and two purchases while one replica was killed and the other drained; both deliveries show once in the dashboard. No local Kubernetes cluster was run: the disk was 99% full (4.9 GB free), too little for a kind node image plus the RevenueDot image loaded into it. A Helm chart (`deploy/helm/revenuedot`), Terraform for AWS and GCP (`deploy/terraform/`), an AWS Marketplace listing package (`deploy/aws-marketplace/`) are ready; CI lints and validates the chart and the Terraform. Nothing has been applied to a cloud account and nothing has been submitted to AWS.

## Users and jobs
- **A platform team at a large app** runs RevenueDot on its own Kubernetes or AWS account, with no single server whose loss stops purchases.
- **The same team during an upgrade** rolls out a new version one pod at a time while the SDKs keep getting answers, and the database migrates once.
- **Their security reviewer** reads one page that says what runs where, which ports are open, where secrets live and what the SLA promises.
- **A buyer in AWS Marketplace** finds RevenueDot, reads the usage instructions and deploys it into their own account.

## What "safe to run as N replicas" means
Every piece of state a request or the background job relies on must live in Postgres, and every piece of background work must run once.

| Concern | Before | Now |
|---|---|---|
| Migrations | every replica migrated on start; two at once could collide | `pg_advisory_lock` around the migration on a reserved connection: the first replica migrates, the others wait and then find nothing to do. `REVENUEDOT_MIGRATE=skip` turns it off for replicas when a Helm hook Job (`node --import tsx src/migrate.node.ts`) runs migrations before the rollout; a replica started that way refuses to run on a database missing any of its migrations (exit 1 with the command to run) instead of failing later on a missing table |
| Background job (`tick`: expirations, voided purchases, webhooks, integrations, alerts, win-back, credential checks, exports, moves, enterprise work) | an interval in each process; N replicas would run it N times at once | each run takes `pg_try_advisory_lock` on a reserved connection; a replica that finds it held skips that run. The lock is released when the run ends or the connection drops (a crashed pod), so another replica takes over on its next interval. `REVENUEDOT_BACKGROUND_JOBS=off` keeps a replica to requests only |
| Webhook deliveries | selected then sent: two concurrent ticks (also RevenueDot Cloud's cron plus request-kicked ticks) could send the same delivery twice; 50 per run, one at a time | each due delivery is claimed with a conditional `UPDATE` that sets `status = 'sending'` and `next_attempt_at` 2 minutes past the claim (a lease longer than the 60-second request timeout), only while it is due and no other delivery to the same webhook is `sending` under a live lease, as partner deliveries do; only the claimer sends it. So each webhook has one delivery in flight at a time across every run and replica, and gets them oldest first; a claim whose run died lapses and goes out first. Batches of 50 repeat; no claim starts after 20 seconds; different webhooks are sent to in parallel (8). The API shows `sending` as `pending`, and Retry answers 409 while a delivery is being sent |
| Alert emails | the email went out before the alert row was written; two runs could both email | the run whose insert or conditional update changed the alert row sends the email (open, reminder, resolved) |
| Expirations | the EXPIRATION event was recorded, then the subscription marked; two ticks could record it twice | one transaction marks the subscription (`WHERE expired_event_at IS NULL`) and records the event; the second tick finds it marked |
| Integration deliveries, data exports, full exports, moves | already leased per row | unchanged |
| Win-back emails | already once per campaign and customer (unique index) | unchanged |
| Sessions, rate limits, AI streams, OAuth codes | already in Postgres | unchanged |
| Full-export archives | a folder on the pod (lost when the pod goes) | the chart and Terraform set `REVENUEDOT_ARCHIVE_DIR=db` (Postgres) unless an S3 bucket is configured |
| Email links from background work | the last request origin seen by this process | `REVENUEDOT_PUBLIC_URL` is required by the chart and Terraform |

Request-kicked runs (a purchase queues a webhook and kicks the job 250 ms later) try the lock; if another replica holds it, they try again every second for up to 10 seconds; if this replica's own run is going, it runs once more when it ends. A webhook still leaves within seconds.

**Delivery guarantee:** at least once, as with RevenueCat. A replica killed with SIGKILL after the receiver answered but before the result was saved resends that one delivery after the lease. Receivers should de-duplicate on the event `id`; the guides say so.

## Health and shutdown
- `GET /healthz`: liveness. 200 while the process runs; it never touches the database, so a database blip does not restart every pod.
- `GET /readyz`: readiness. 200 when `select 1` answers within 2 seconds and the replica is not shutting down; 503 otherwise.
- SIGTERM or SIGINT: `/readyz` turns 503, the job interval stops, a running job stops after the webhooks in flight and skips its long steps (integrations, exports, AdMob, full exports, moves), answers carry `Connection: close`, the replica waits `REVENUEDOT_SHUTDOWN_DELAY_MS` (default 5 s) so the load balancer stops routing, closes the listener, waits for in-flight requests, the running job and store-notification forwards up to `REVENUEDOT_SHUTDOWN_TIMEOUT_MS` (default 20 s), logs what it waited for, closes the pool and exits 0 (after a timeout it exits without waiting on the pool). A second signal exits at once. Kubernetes' default 30-second grace period covers it; the chart refuses a delay plus timeout that does not fit. `pnpm dev` sets the delay to 0, so restarts on file changes stay quick.

## Settings added
| Variable | Default | Meaning |
|---|---|---|
| `REVENUEDOT_MIGRATE` | `auto` | `auto` migrates on start under the lock; `skip` never does |
| `REVENUEDOT_BACKGROUND_JOBS` | `on` | `off`: this replica serves requests only |
| `REVENUEDOT_TICK_INTERVAL_MS` | `30000` | how often each replica tries to run the job |
| `REVENUEDOT_SHUTDOWN_DELAY_MS` | `5000` | wait after readiness turns 503 |
| `REVENUEDOT_SHUTDOWN_TIMEOUT_MS` | `20000` | longest drain |
| `DATABASE_POOL_MAX` | `10` | connections per replica (at least 2: one is reserved for locks) |

**Connection poolers:** the locks are session advisory locks. Connect directly to Postgres, through RDS Proxy (it pins the session) or PgBouncer in session mode. PgBouncer in transaction mode breaks them.

## Reference setups
**Helm chart `deploy/helm/revenuedot`:** Deployment (2 replicas by default, rolling update with `maxUnavailable: 0`, topology spread across zones and nodes), HorizontalPodAutoscaler (CPU and memory), PodDisruptionBudget (`minAvailable: 1`), Service, optional Ingress, ServiceAccount, liveness `/healthz`, readiness `/readyz`, startup probe, resources, non-root `securityContext` with a read-only root filesystem and all capabilities dropped, a migration Job as a `pre-install,pre-upgrade` hook, Secret references for every secret (`existingSecret`) or a chart-made Secret, an external Postgres URL (required in production) and an optional bundled single-pod Postgres for evaluation only (NOTES warn; rendering refuses zero or two database sources). `image.repository` is required until an image is published. Autoscaling is on CPU only by default (Node rarely returns memory, so memory-based scaling only adds replicas and Postgres connections). Checked by `helm lint`, `helm template`, refusals of bad values and kubeconform (Kubernetes 1.29 to 1.33, strict) in CI.

**Terraform `deploy/terraform/aws`:** VPC across 3 zones (public, private and database subnets, one NAT gateway per zone), RDS PostgreSQL 16 Multi-AZ (encrypted with a KMS key, 14-day backups, Performance Insights, deletion protection, `rds.force_ssl`), ECS Fargate service (2 to 10 tasks, CPU target tracking, deployment circuit breaker with rollback, spread over the private subnets), a one-off migration task definition, Application Load Balancer (HTTPS only, TLS 1.3 policy, HTTP to HTTPS redirect, health check `/readyz`, deregistration delay 30 s), ACM certificate with DNS validation in Route 53, Secrets Manager for the database URL, signing and encryption keys, CloudWatch log group and alarms (ALB 5xx, target response time, unhealthy hosts, RDS CPU, free storage, connections, ECS running tasks below the minimum) to an SNS topic. EKS is left out on purpose: the Helm chart covers Kubernetes, and Fargate is the smaller thing to run.

**Terraform `deploy/terraform/gcp`:** Cloud Run v2 service (2 to 10 instances, CPU always allocated so the job interval runs, Direct VPC egress), Cloud SQL for PostgreSQL 16 with regional availability (HA), private IP and automatic backups with point-in-time recovery, Secret Manager, a Cloud Run job for migrations, and Cloud Monitoring alert policies.

Both are checked by `terraform fmt -check`, `terraform validate` and tflint in CI. Nothing here has ever been applied.

## SLA and Marketplace
- The SLA guide `guides/sla.md` (RevenueDot Cloud uptime on the purchase path, service credits, support response times for Enterprise, self-hosted included, and what self-hosted customers own) is a separate draft pull request in revenuedot/docs. Its numbers come from the private enterprise pricing sheet; the terms wait on Kai's approval.
- `deploy/aws-marketplace/`: container product metadata (`product.yaml`), usage instructions, the architecture diagram (SVG), the Helm and ECS delivery options and a submission checklist. Pricing is a decision for Kai (see the checklist); nothing is submitted.

## Tests
- `packages/contract/test/cluster.test.ts` (PGlite, and real Postgres in CI's `test-postgres` job): two concurrent `deliverDue` calls send each delivery once; a burst larger than a batch goes out in one run in order per webhook; a draining replica stops claiming; a dead run's claim holds its webhook back until it lapses, then goes out first; same-instant events keep their order; a send that throws stops only its webhook; a run out of time claims no more; a delivery being sent shows as pending and Retry answers 409; two concurrent expiration scans record one EXPIRATION; the tick lock lets one of two concurrent runs through; readiness and settings. `apps/server/test/alerts.test.ts`: two alert runs at once send one open, one reminder and one resolved email. On the old code these fail with 12 sends for 6 deliveries, 8 expirations for 4 and 2 open emails for 1.
- `scripts/e2e/cluster/run.ts`: a fresh database on the Railway development Postgres, three real Node replicas started at the same moment (concurrent migrations), a capture server as the webhook receiver and an SMTP sink, 300 Test Store purchases spread over the replicas by a load balancer that health-checks `/readyz`, forced expirations, a failing webhook that opens an alert email, one replica sent SIGTERM mid-run and started again. Checks: every replica started; each migration applied once; every event delivered exactly once to the good endpoint; no delivery row stuck; one alert email; no two job runs overlapped (from the replicas' job logs); `/readyz` 503 during the drain; no failed request at the load balancer level. The database is dropped at the end.

## Later
- The image is on GHCR since 2026-10-03 (`ghcr.io/revenuedot/revenuedot`, the chart's default). Still to do: an ECR copy, cosign signatures, and the chart pinned to a release tag.
- An EKS module that installs the chart; Azure (Container Apps and Flexible Server).
- Read replicas for charts and exports.
- Leader-aware metrics (`/metrics` for Prometheus).
