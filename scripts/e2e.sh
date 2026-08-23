#!/usr/bin/env bash
#
# Boots a disposable ScyllaDB container, runs the e2e suite against it, and
# always tears the container down — even when the suite or the boot fails.
set -euo pipefail

CONTAINER_NAME='scyllorm-e2e'
READINESS_TIMEOUT_SECONDS=240
READINESS_POLL_SECONDS=5

cleanup() {
    docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
}
trap cleanup EXIT

# A leftover container from a previous run holds the name and the port; drop it first
if docker ps -a --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
    echo "Removing existing ${CONTAINER_NAME} container..."
    docker rm -f "${CONTAINER_NAME}" > /dev/null
fi

echo 'Starting ScyllaDB container...'
docker run -d --rm --name "${CONTAINER_NAME}" -p 127.0.0.1:9042:9042 scylladb/scylla \
    --smp 1 --memory 1G --overprovisioned 1 --developer-mode 1 --skip-wait-for-gossip-to-settle 0 > /dev/null

echo "Waiting up to ${READINESS_TIMEOUT_SECONDS}s for CQL to come up..."
elapsed=0
until docker exec "${CONTAINER_NAME}" cqlsh -e 'describe cluster' > /dev/null 2>&1; do
    if (( elapsed >= READINESS_TIMEOUT_SECONDS )); then
        echo "ScyllaDB did not become ready within ${READINESS_TIMEOUT_SECONDS}s" >&2
        exit 1
    fi
    sleep "${READINESS_POLL_SECONDS}"
    elapsed=$(( elapsed + READINESS_POLL_SECONDS ))
done
echo "ScyllaDB is ready after ~${elapsed}s."

npx vitest run --config vitest.e2e.config.ts
