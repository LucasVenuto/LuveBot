#!/bin/sh
# D-007 screen harness: real Hermes + the REAL LuveBot plugin of this checkout + the Bot Desktop stack. Separate compose project.
#   tests/harness/display/run.sh            the live-screen test
#   MUTATE=1 tests/harness/display/run.sh   then each mutation of mutate_display.py must turn it red
# Needs the image luvebot-display-spike:f8489405 (docker build -t luvebot-display-spike:f8489405 tests/harness/spikes/display).
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export DISPLAY_STATE=${DISPLAY_STATE:-/tmp/luvebot-display}
export LUVEBOT_REPO=${LUVEBOT_REPO:-$(CDPATH= cd -- "$here/../../.." && pwd)}
compose="docker compose -p luvebot-display -f $here/compose.yaml"
HARNESS_STATE="$DISPLAY_STATE" python3 "$here/../prepare_harness.py"
$compose down -v >/dev/null 2>&1 || true
$compose up -d
i=0
until $compose exec -T hermes python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:9119/api/health',timeout=2);assert os.path.exists('/fixtures/ports-after.json')" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -lt 120 ] || { echo "the screen harness did not come up" >&2; $compose logs --tail 40 hermes; exit 1; }
    sleep 3
done
$compose exec -T hermes python -m pytest -c /dev/null -p no:cacheprovider -s -v --basetemp=/tmp/d007 \
    /root/.hermes/plugins/luvebot/tests/harness/display/test_screen_live.py
if [ -n "${MUTATE:-}" ]; then
    python3 "$here/mutate_display.py"
fi
