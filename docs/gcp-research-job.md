# Scheduled GCP Research Job

This deployment runs one non-executing research cycle in a Cloud Run Job, stores its authoritative event ledger in Cloud SQL for PostgreSQL, and uses Cloud Scheduler only as a wall-clock trigger. The application remains authoritative for market-calendar and research eligibility.

## Runtime Safety

The job command is pinned to:

```bash
pnpm agent:once -- --dry-run
```

Dry-run invocation provenance prevents execution authorization creation, and the composition root skips the isolated trader. Keep task count and parallelism at one. PostgreSQL also holds a deployment-wide advisory lock, so an overlapping execution fails before opening a research session.

## Required Services

Enable these APIs in the target project:

```bash
gcloud services enable \
  artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com
```

Create the following resources through `gcloud` or the Google Cloud console:

- One regional Cloud SQL for PostgreSQL 16 instance.
- Database `research` and a dedicated application user.
- A Cloud Run runtime service account with `roles/cloudsql.client`.
- A Scheduler service account with `roles/run.invoker` on only the research job.
- Secret Manager secrets for `PGPASSWORD`, `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `FMP_API_KEY`, `EXA_API_KEY`, and `OPENAI_API_KEY`.
- One Artifact Registry Docker repository.

Use a generated database password. Do not place it in shell history, source control, image layers, or Cloud Run plain-text environment variables.

## Build

From the repository root:

```bash
gcloud builds submit \
  --tag REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/research-agent:IMAGE_TAG
```

The image contains Node 22, pnpm, OpenCode, the checked-in agent policies, MCP launchers, and `uvx` for the pinned Alpaca MCP server. Deprecated SQLite source and `better-sqlite3` are omitted from the runtime stage.

## Automated Delivery

`.github/workflows/ci-cd.yml` runs typechecking, tests, application and documentation builds, and a production container build on pull requests to `develop`. On a push to `develop`, the same verification gates an immutable `${GITHUB_SHA}` image build in Cloud Build and an image-only update of the existing Cloud Run Job.

The deploy job uses GitHub OpenID Connect and Workload Identity Federation. It does not use a downloaded service-account key. Configure these GitHub Actions repository variables:

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `GCP_ARTIFACT_REPOSITORY`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_DEPLOY_SERVICE_ACCOUNT`
- `CLOUD_RUN_JOB`

Restrict the Workload Identity principal to this repository and the `develop` branch. Grant its deploy service account only permission to submit Cloud Builds, use enabled services, update the existing Cloud Run Job, and act as the job runtime service account. The Cloud Build runtime identity, not the GitHub identity, writes images to Artifact Registry.

The `research-production` GitHub environment provides the deployment boundary. Environment protection rules can require operator approval without changing the workflow. The deploy step changes only the image, preserving the job command, secret bindings, Cloud SQL attachment, task limits, runtime service account, and `RESEARCH_ONLY` configuration.

## Deploy The Job

Cloud Run mounts the Cloud SQL Unix socket at `/cloudsql/INSTANCE_CONNECTION_NAME`. Replace the uppercase placeholders:

```bash
gcloud run jobs deploy research-agent \
  --image REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/research-agent:IMAGE_TAG \
  --region REGION \
  --service-account RUNTIME_SERVICE_ACCOUNT \
  --tasks 1 \
  --parallelism 1 \
  --max-retries 0 \
  --task-timeout 20m \
  --set-cloudsql-instances INSTANCE_CONNECTION_NAME \
  --set-env-vars 'DEPLOYMENT_ROLE=RESEARCH_ONLY,RESEARCH_LEDGER_BACKEND=postgres,PGHOST=/cloudsql/INSTANCE_CONNECTION_NAME,PGPORT=5432,PGDATABASE=research,PGUSER=RESEARCH_DATABASE_USER,AGENT_LOG_FORMAT=json,AGENT_CYCLE_TIMEOUT_MS=900000,OTEL_SDK_DISABLED=true' \
  --set-secrets 'PGPASSWORD=PGPASSWORD:latest,ALPACA_API_KEY=ALPACA_API_KEY:latest,ALPACA_SECRET_KEY=ALPACA_SECRET_KEY:latest,FMP_API_KEY=FMP_API_KEY:latest,EXA_API_KEY=EXA_API_KEY:latest,OPENAI_API_KEY=OPENAI_API_KEY:latest' \
  --command pnpm \
  --args agent:once,--,--dry-run
```

Grant the runtime service account Secret Manager access only to the six named secrets. Do not grant it project-wide Secret Manager administration.

Execute the job manually once before scheduling it:

```bash
gcloud run jobs execute research-agent --region REGION --wait
```

The first execution applies one fresh PostgreSQL schema migration. It does not import or read an existing SQLite ledger.

## Schedule

During dry-run testing, run every 30 minutes from 09:00 through 15:30 ET on weekdays:

```bash
gcloud scheduler jobs create http research-agent-30m-et \
  --location REGION \
  --schedule '*/30 9-15 * * 1-5' \
  --time-zone America/New_York \
  --uri 'https://run.googleapis.com/v2/projects/PROJECT_ID/locations/REGION/jobs/research-agent:run' \
  --http-method POST \
  --oauth-service-account-email SCHEDULER_SERVICE_ACCOUNT \
  --max-retry-attempts 0
```

Cloud Scheduler does not understand exchange holidays or half-days. Those triggers remain harmless because the application queries the Alpaca calendar and fails closed outside an eligible session.

Each trigger can launch a full model-backed research cycle. Do not shorten this interval until deterministic cheap scans can suppress unnecessary agent invocations.

## Inspect Stored Research

The Cloud SQL ledger stores the complete validated report, symbol screen, decision, shadow-risk result, lifecycle metadata, and invocation provenance. Point the existing run reader at the same PostgreSQL environment:

```bash
RESEARCH_LEDGER_BACKEND=postgres \
PGHOST=/path/to/cloud-sql-proxy/socket \
PGDATABASE=research \
PGUSER=RESEARCH_DATABASE_USER \
PGPASSWORD=... \
pnpm research:run
```

For local inspection, use the Cloud SQL Auth Proxy rather than opening the database to arbitrary source addresses.
