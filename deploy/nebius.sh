#!/usr/bin/env bash
# Deploy Menusmith to Nebius AI Cloud Serverless.
#
#   1. Serverless ENDPOINT  — the web app + API (public URL for judges)
#   2. Serverless JOB       — the fleet: re-runs every extractor, heals broken ones
#
# Prereqs: the `nebius` CLI configured with a profile (project + region),
# a container registry you can push to, and the two API keys as env vars:
#   export NEBIUS_API_KEY=...   TAVILY_API_KEY=...
#   export IMAGE=cr.<region>.nebius.cloud/<registry-id>/menusmith:latest
#   export SUBNET_ID=<subnet id from `nebius vpc subnet list`>
#
# Usage: deploy/nebius.sh build | endpoint | fleet-job | url
set -euo pipefail
cmd="${1:-}"
: "${IMAGE:?set IMAGE to your registry path}"

case "$cmd" in
  build)
    docker build --platform linux/amd64 -t "$IMAGE" .
    docker push "$IMAGE"
    ;;
  endpoint)
    : "${NEBIUS_API_KEY:?}" "${SUBNET_ID:?}"
    nebius ai endpoint create \
      --name menusmith \
      --image "$IMAGE" \
      --container-port 8790 \
      --platform cpu-d3 --preset 4vcpu-16gb \
      --env "NEBIUS_API_KEY=${NEBIUS_API_KEY}" \
      --env "TAVILY_API_KEY=${TAVILY_API_KEY:-}" \
      --env "MENUSMITH_FORGES_PER_HOUR=12" \
      --public \
      --subnet-id "$SUBNET_ID"
    ;;
  fleet-job)
    : "${NEBIUS_API_KEY:?}" "${SUBNET_ID:?}"
    # A run-to-completion job: re-run all extractors (0 tokens when healthy),
    # heal the ones a website redesign broke, write the fleet report.
    nebius ai job create \
      --name "menusmith-fleet-$(date +%Y%m%d-%H%M)" \
      --image "$IMAGE" \
      --container-command npx --args "tsx src/cli.ts fleet" \
      --platform cpu-d3 --preset 4vcpu-16gb \
      --env "NEBIUS_API_KEY=${NEBIUS_API_KEY}" \
      --env "TAVILY_API_KEY=${TAVILY_API_KEY:-}" \
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
