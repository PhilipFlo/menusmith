# Deploying Menusmith on Nebius AI Cloud

Two pieces run on Nebius AI Cloud Serverless:

| Piece | Nebius service | What it does |
|---|---|---|
| Web app + API | **Serverless Endpoint** (CPU) | The public demo URL for judges |
| Fleet | **Serverless Job** (CPU) | Re-runs every extractor, heals broken ones |

Models are called on **Nebius Token Factory** from both.

## One-time setup (needs you — logins happen in your browser)

1. **Docker Desktop** — install from docker.com and start it (the whale icon must be running).
2. **Nebius CLI**
   ```bash
   curl -sSL https://artifacts.nebius.cloud/cli/install.sh | bash
   exec -l $SHELL
   nebius version
   ```
3. **Log in** (opens the Nebius console in your browser; pick your project)
   ```bash
   nebius profile create
   ```
   Accept the defaults (API endpoint, `federation` auth). Then check: `nebius profile list`.
4. **Container registry + Docker login helper** (needs `jq`: `brew install jq`)
   ```bash
   nebius registry create --name menusmith --format json | jq -r ".metadata.id"
   nebius registry configure-helper
   ```
   Note the registry id it prints (e.g. `registry-e00abc…`) and your region (e.g. `eu-north1`).
5. **Subnet id** for the deployment:
   ```bash
   nebius vpc subnet list --format json | jq -r ".items[0].metadata.id"
   ```

6. **Shared filesystem** — the endpoint and the fleet job both mount it at `/data`, so the
   job's healed extractors and fleet reports show up in the web app:
   ```bash
   nebius compute filesystem create --parent-id <your project id> --name menusmith-data \
     --type network_ssd --size-gibibytes 10 --format json | jq -r ".metadata.id"
   ```

Then tell Claude the region, the registry id (without `registry-`), the subnet id and the
filesystem id — the rest is scripted.

## Deploy (scripted)

```bash
export IMAGE=cr.<region>.nebius.cloud/<registry-id-without-prefix>/menusmith:latest
export SUBNET_ID=<subnet id>
export VOLUME=<filesystem id>
export NEBIUS_API_KEY=...  TAVILY_API_KEY=...   # from .env
deploy/nebius.sh build       # docker build + push (linux/amd64)
deploy/nebius.sh endpoint    # public web app
deploy/nebius.sh fleet-job   # one fleet run as a Serverless Job
deploy/nebius.sh url         # print the public URL
```

## Keeping costs down

- The endpoint is billed per second while running. Stop it when you're not demoing and
  start it again for the judging period (Dec 1–15):
  `nebius ai endpoint stop <id>` / `nebius ai endpoint start <id>`.
- Model spend from the public demo is capped by `MENUSMITH_DAILY_BUDGET_USD` (default $3/day)
  and `MENUSMITH_MAX_JOB_USD` (default $0.50 per forge).
- Set `MENUSMITH_ADMIN_TOKEN` to keep full fleet runs private; the public can only run the
  fleet over the demo restaurants, at most every 3 minutes.
