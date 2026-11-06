#!/bin/sh
set -eu
harness_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
hermes_source=${HERMES_SOURCE:-/tmp/hermes-agent}
expected=f8489405600c9a7d9d2f307dace086f18d7173ba
actual=$(git -C "$hermes_source" rev-parse HEAD)
[ "$actual" = "$expected" ] || { echo "Wrong Hermes revision: $actual" >&2; exit 1; }
[ -z "$(git -C "$hermes_source" status --porcelain)" ] || { echo "Hermes checkout is not clean" >&2; exit 1; }
python3 "$harness_dir/prepare_harness.py"
docker compose -f "$harness_dir/compose.yaml" build hermes
docker compose -f "$harness_dir/compose.yaml" up -d
