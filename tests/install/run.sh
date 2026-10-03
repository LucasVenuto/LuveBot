#!/bin/sh
# Gate 1 (MAESTRO.md section 5): install from zero following ONLY the README, in a NEW container from the clean Hermes
# image: no bind mounts, no harness prepare, no harness ports. The commands are read out of the README itself
# (blocks tagged `<!-- install-test: NAME -->`) and executed verbatim; the only substitution is the TBD clone URL,
# replaced by a git repository made from this working tree inside the container.
#   ./tests/install/run.sh                 (needs Docker and the image luvebot-hermes-test:f8489405 from tests/harness/up.sh)
#   LAUNCHER=shell ./tests/install/run.sh  the same, with `hermes` replaced by the shell launcher Hermes's managed installs
#                                          write ("#!/bin/sh" + exec, hermes_cli/_launchers.py), as on the CEO's VPS (T10.2).
#                                          Run both: the default image has a Python console-script launcher.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
image=${LUVEBOT_TEST_IMAGE:-luvebot-hermes-test:f8489405}
name=luvebot-install-$$
work=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] || docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
dx() { docker exec "$name" "$@"; }
# the restarted dashboard is up when ITS OWN log says so (the old one may still answer /api/health while it is being stopped)
wait_ready() {
    i=0
    until dx grep -q HERMES_DASHBOARD_READY "$1" 2>/dev/null; do
        i=$((i + 1)); [ "$i" -lt 180 ] || { echo "dashboard did not come back" >&2; exit 1; }
        sleep 1
    done
}

# README -> one script per tagged block
python3 - "$repo/README.md" "$work" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
for tag, code in re.findall(r'<!-- install-test: (\w+) -->\n```sh\n(.*?)```', text, re.S):
    open(f'{sys.argv[2]}/{tag}.sh', 'w').write(code)
PY
for tag in install restart verify verify2 uninstall; do [ -s "$work/$tag.sh" ] || { echo "README has no '$tag' block" >&2; exit 1; }; done

docker run -d --name "$name" --entrypoint sleep "$image" infinity >/dev/null
echo "== fresh container $(dx hostname) from $image; mounts: $(docker inspect -f '{{len .Mounts}}' "$name"); published ports: $(docker inspect -f '{{len .NetworkSettings.Ports}}' "$name")"
dx hermes --version | head -1
dx mkdir -p /tmp/t /tmp/src
docker cp "$here/prereq.py" "$name:/tmp/t/prereq.py"
docker cp "$here/checks.py" "$name:/tmp/t/checks.py"
for tag in install restart verify verify2 uninstall; do docker cp "$work/$tag.sh" "$name:/tmp/t/$tag.sh"; done

echo "== the user's machine has curl and ps (the slim image ships neither; 'hermes dashboard --stop' finds processes with ps)"
dx sh -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends curl procps >/dev/null' && dx curl --version | head -1
if [ "${LAUNCHER:-python}" = shell ]; then
    echo "== the user's 'hermes' is the shell launcher Hermes's own code writes (_mint_shell_launcher + _launcher_script)"
    docker exec -i "$name" python -B - <<'PY'
import sys
from pathlib import Path
from hermes_cli._launchers import _launcher_script, _mint_shell_launcher
assert _mint_shell_launcher('hermes', Path('/usr/local/bin'), Path(sys.executable), _launcher_script('hermes', Path('/opt/hermes'), None))
PY
fi
echo "== launcher: $(dx head -n 1 /usr/local/bin/hermes)"
echo "== prerequisites (the user's existing Hermes: auth + profile API key + gateway + dashboard)"
dx python /tmp/t/prereq.py
echo "== before install"
dx python /tmp/t/checks.py before

echo "== the 'clone': this working tree (tracked files) as a git repository"
(cd "$repo" && git ls-files -z | COPYFILE_DISABLE=1 tar --null -T - -cf -) | docker exec -i "$name" tar -x -C /tmp/src
dx sh -ec 'cd /tmp/src && git init -q && git add -A && git -c user.name=t -c user.email=t@t commit -qm clone'
dx sh -ec 'sed -i "s|https://github.com/LucasVenuto/LuveBot.git|file:///tmp/src|" /tmp/t/*.sh'

echo "== README: Install"
dx sh -e /tmp/t/install.sh
echo "== README: Restart the dashboard"
docker exec -d "$name" sh -c 'sh -e /tmp/t/restart.sh >/tmp/t/restart.log 2>&1'
wait_ready /tmp/t/restart.log
echo "== README: Check that it works"
code=$(dx sh -e /tmp/t/verify.sh)
echo "curl without session -> $code"
[ "$code" = 401 ]
dx sh -c 'sh -e /tmp/t/verify2.sh > /tmp/t/verify2.out'
dx sh -c 'head -c 400 /tmp/t/verify2.out; echo'
dx python /tmp/t/checks.py after

echo "== README: Uninstall (then restart)"
dx sh -e /tmp/t/uninstall.sh
echo "== --uninstall again, from the source copy (idempotent: plugin dir and theme already gone, exit 0), and a bad flag (exit 2)"
dx sh -ec 'HERMES_PYTHON=python /tmp/src/scripts/install.sh --uninstall'
dx sh -c 'HERMES_PYTHON=python /tmp/src/scripts/install.sh --nope >/dev/null 2>&1; echo "bad flag exit: $?"'
docker exec -d "$name" sh -c 'sh -e /tmp/t/restart.sh >/tmp/t/restart2.log 2>&1'
wait_ready /tmp/t/restart2.log
dx python /tmp/t/checks.py gone
echo "INSTALL FROM README: OK"
