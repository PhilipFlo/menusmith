#!/usr/bin/env bash
# Deploy Menusmith to Nebius AI Cloud Serverless.
#
#   1. Serverless ENDPOINT  — the web app + API (public URL for judges)
#   2. Serverless JOB       — the fleet: re-runs every extractor, heals broken ones
#
# Prereqs: the `nebius` CLI configured with a profile (project + region) and
# a container registry you can push to. API keys are NEVER passed as plain env
# vars: `deploy/nebius.sh secrets` copies them from .env into Nebius MysteryBox,
# and the endpoint/job read them with --env-secret.
#   export IMAGE=cr.<region>.nebius.cloud/<registry-id>/menusmith:latest
#   export SUBNET_ID=<subnet id from `nebius vpc subnet list`>
#
#   export VOLUME=<filesystem id>   (shared by the endpoint and the fleet job, mounted at /data)
#
# Usage: deploy/nebius.sh secrets | build | endpoint | fleet-job | url
set -euo pipefail
cmd="${1:-}"
[ "$cmd" = secrets ] || : "${IMAGE:?set IMAGE to your registry path}"

# Read a key from .env without printing it.
envval() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }

case "$cmd" in
  secrets)
    for k in NEBIUS_API_KEY TAVILY_API_KEY; do
      v="$(envval "$k")"
      [ -n "$v" ] || { echo "$k missing in .env" >&2; exit 1; }
      name="menusmith-$(echo "$k" | tr 'A-Z_' 'a-z-')"
      nebius mysterybox secret create --name "$name" --description "Menusmith $k" \
        --secret-version-payload "[{\"key\": \"$k\", \"string_value\": \"$v\"}]" >/dev/null
      echo "stored $k in MysteryBox secret '$name'"
    done
    ;;
  build)
    docker build --platform linux/amd64 -t "$IMAGE" .
    docker push "$IMAGE"
    ;;
  endpoint)
    : "${SUBNET_ID:?}"
    nebius ai endpoint create \
      --name menusmith \
      --image "$IMAGE" \
      --container-port 8790 \
      --platform cpu-d3 --preset 4vcpu-16gb --disk-size 30Gi \
      --volume "${VOLUME:?set VOLUME}:/data" \
      --env "MENUSMITH_LIBRARY=/data/library" --env "MENUSMITH_CACHE=/data/cache" \
      --env-secret "NEBIUS_API_KEY=menusmith-nebius-api-key" \
      --env-secret "TAVILY_API_KEY=menusmith-tavily-api-key" \
      --env "MENUSMITH_FORGES_PER_HOUR=12" \
      --env "MENUSMITH_DAILY_BUDGET_USD=${MENUSMITH_DAILY_BUDGET_USD:-3}" \
      --env "MENUSMITH_ADMIN_TOKEN=${MENUSMITH_ADMIN_TOKEN:-}" \
      --public \
      --subnet-id "$SUBNET_ID"
    ;;
  fleet-job)
    : "${SUBNET_ID:?}"
    # A run-to-completion job: re-run all extractors (0 tokens when healthy),
    # heal the ones a website redesign broke, write the fleet report.
    nebius ai job create \
      --name "menusmith-fleet-$(date +%Y%m%d-%H%M)" \
      --image "$IMAGE" \
      --container-command npx --args "tsx src/cli.ts fleet" \
      --platform cpu-d3 --preset 4vcpu-16gb --disk-size 30Gi \
      --volume "${VOLUME:?set VOLUME}:/data" \
      --env "MENUSMITH_LIBRARY=/data/library" --env "MENUSMITH_CACHE=/data/cache" \
      --env-secret "NEBIUS_API_KEY=menusmith-nebius-api-key" \
      --env-secret "TAVILY_API_KEY=menusmith-tavily-api-key" \
      --timeout 2h --restart-policy never \
      --subnet-id "$SUBNET_ID"
    ;;
  url)
    nebius ai endpoint get-by-name --name menusmith --format json | grep -o '"public_endpoints"[^]]*'
    ;;
  *)
    echo "usage: $0 build | endpoint | fleet-job | url" >&2
    exit 1
    ;;
esac
