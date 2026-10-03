#!/bin/sh
# T3.0c: does pre_tool_call do what ADR-002 presumes? A NEW container from the clean Hermes image (no mounts, no ports,
# the existing harness and the real plugin untouched). The spike plugin lives only in that container's ~/.hermes/plugins.
#   ./tests/harness/spikes/hook/run.sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
image=${LUVEBOT_TEST_IMAGE:-luvebot-hermes-test:f8489405}
name=luvebot-hookspike-$$
trap '[ -n "${KEEP:-}" ] || docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$name" --entrypoint sleep "$image" infinity >/dev/null
dx() { docker exec "$name" "$@"; }
echo "== fresh container $(dx hostname); mounts: $(docker inspect -f '{{len .Mounts}}' "$name"); published ports: $(docker inspect -f '{{len .NetworkSettings.Ports}}' "$name")"
dx hermes --version | head -1
dx mkdir -p /tmp/hook-spike /root/.hermes/plugins
docker cp "$here/plugin" "$name:/root/.hermes/plugins/luvebot_hook_spike"
for f in fake_model.py setup_container.py drive.py; do docker cp "$here/$f" "$name:/tmp/hook-spike/$f"; done
dx python /tmp/hook-spike/setup_container.py 1 1 0 >/dev/null
dx python /tmp/hook-spike/drive.py
mkdir -p "$here/evidence"
docker cp "$name:/tmp/hook-spike/evidence.json" "$here/evidence/result.json"
echo "evidence: tests/harness/spikes/hook/evidence/"
