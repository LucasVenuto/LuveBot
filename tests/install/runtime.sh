#!/bin/sh
# How scripts/install.sh finds the Python that runs Hermes (T10.2), on the host, without Docker. Each case uses a fresh
# HERMES_HOME and a PATH holding only one `hermes` launcher:
#   - a Python launcher (a venv console script, "#!<venv>/bin/python");
#   - a shell launcher written by Hermes's OWN code (hermes_cli/_launchers.py _mint_shell_launcher + _launcher_script,
#     "#!/bin/sh" + exec), the kind the CEO's VPS has; it answers --run-module and --print-runtime-command;
#   - an older shell launcher that refuses --run-module, so only --print-runtime-command is left;
#   - the failures: HERMES_PYTHON=/bin/sh (what the old README derived on that VPS), a shell launcher that answers nothing,
#     no `hermes` on PATH, a bad flag. Each must stop with a message and leave NOTHING behind.
# The Hermes files (hermes_cli/, pm/, hermes_constants.py, hermes_bootstrap.py) are copied unmodified from a clean checkout
# at f8489405 (the runtime command really runs Hermes's bootstrap); only hermes_cli/plugins_cmd.py is replaced by a stub that records the call (the real one needs Hermes's dependencies; the
# Docker install test, tests/install/run.sh, runs the real one).
#   HERMES_SOURCE=/tmp/hermes-agent ./tests/install/runtime.sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
src=${HERMES_SOURCE:-/tmp/hermes-agent}
[ "$(git -C "$src" rev-parse HEAD)" = f8489405600c9a7d9d2f307dace086f18d7173ba ] || { echo "need the Hermes checkout at f8489405 in $src" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# A fake Hermes root: the real launcher code, a stub activation.
root="$work/hermes-root"
mkdir -p "$root"
cp "$src/hermes_constants.py" "$src/hermes_bootstrap.py" "$root/"
cp -R "$src/pm" "$src/hermes_cli" "$root/"
cat > "$root/hermes_cli/plugins_cmd.py" <<'PY'
import os
from pathlib import Path


def _set_plugin_enabled(name, *, enable, aliases=(), console=None):
    with open(Path(os.environ["HERMES_HOME"]) / "activation.log", "a") as log:
        log.write(f"{name} {'enable' if enable else 'disable'}\n")
PY
find "$root" -name __pycache__ -prune -exec rm -rf {} +

# Launchers, each in its own bin directory.
python3 -m venv "$work/venv"
site=$("$work/venv/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
echo "$root" > "$site/hermes-root.pth"
mkdir -p "$work/bin-python" "$work/bin-shell" "$work/bin-old" "$work/bin-mute" "$work/bin-none"
printf '#!%s\nimport sys\nsys.exit("console script stub")\n' "$work/venv/bin/python" > "$work/bin-python/hermes"
python3 -B - "$root" "$work/bin-shell" <<'PY'
import sys
from pathlib import Path
root = Path(sys.argv[1]); sys.path.insert(0, str(root))
from hermes_cli._launchers import _launcher_script, _mint_shell_launcher
assert _mint_shell_launcher("hermes", Path(sys.argv[2]), Path(sys.executable), _launcher_script("hermes", root, None))
PY
printf '#!/bin/sh\nexec /nonexistent/hermes "$@"\n' > "$work/bin-mute/hermes"
printf '#!/bin/sh\n[ "${1:-}" != --run-module ] || { echo "hermes: unknown option --run-module" >&2; exit 2; }\nexec %s "$@"\n' "$work/bin-shell/hermes" > "$work/bin-old/hermes"
chmod +x "$work"/bin-*/hermes
echo "== the shell launcher Hermes writes: $(head -n 1 "$work/bin-shell/hermes") + $(sed -n 2p "$work/bin-shell/hermes" | cut -c1-40)..."
echo "   what the old README derived from it: HERMES_PYTHON=$(head -n 1 "$work/bin-shell/hermes" | sed 's/^#!//')"

case_home() { rm -rf "$work/home"; mkdir -p "$work/home"; }
nothing_left() {
    [ ! -e "$work/home/plugins/luvebot" ] && [ ! -e "$work/home/dashboard-themes/luve.yaml" ] && [ ! -e "$work/home/activation.log" ] \
        || fail "$1 left something behind: $(cd "$work/home" && find . -mindepth 1 | head -5 | tr '\n' ' ')"
}
run() {  # run BIN [VAR=VALUE...] -- ARGS: install.sh with PATH holding that bin first and only the system tools
    bin=$1; shift
    env -i HOME="$work" HERMES_HOME="$work/home" PATH="$work/$bin:/usr/bin:/bin" "$@"
}

for bin in bin-python bin-shell bin-old; do
    echo "== $bin: install, then uninstall"
    case_home
    run "$bin" sh "$repo/scripts/install.sh" || fail "$bin: install failed"
    [ -f "$work/home/dashboard-themes/luve.yaml" ] && [ -f "$work/home/plugins/luvebot/dashboard/manifest.json" ] || fail "$bin: files missing"
    [ "$(cat "$work/home/activation.log")" = 'luvebot enable' ] || fail "$bin: not enabled through plugins_cmd"
    run "$bin" sh "$repo/scripts/install.sh" --uninstall || fail "$bin: uninstall failed"
    [ "$(tail -n 1 "$work/home/activation.log")" = 'luvebot disable' ] && [ ! -e "$work/home/plugins/luvebot" ] || fail "$bin: not removed"
done

expect_refusal() {  # LABEL BIN [VAR=VALUE...]: exit 1, a human message, nothing left
    label=$1; bin=$2; shift 2
    case_home
    set +e
    out=$(run "$bin" "$@" sh "$repo/scripts/install.sh" 2>&1); code=$?
    set -e
    [ "$code" = 1 ] || fail "$label: exit $code"
    printf '%s\n' "$out" | grep -q 'Nothing was installed, enabled or removed.' || fail "$label: no clear message: $out"
    nothing_left "$label"
    echo "== $label: exit 1, nothing left; message: $(printf '%s' "$out" | head -n 1 | cut -c1-150)"
}
expect_refusal 'HERMES_PYTHON=/bin/sh (the old README on the VPS)' bin-shell HERMES_PYTHON=/bin/sh
expect_refusal 'HERMES_PYTHON names a Python without Hermes' bin-shell HERMES_PYTHON=/usr/bin/python3
expect_refusal 'a shell launcher that answers nothing' bin-mute
printf '%s\n' "$out" | grep -q 'Last error: .*nonexistent' || fail "the refusal does not show the launcher's own error: $out"
expect_refusal 'no hermes on PATH' bin-none
echo "== explicit HERMES_PYTHON with the shell launcher on PATH wins"
case_home
run bin-mute HERMES_PYTHON="$work/venv/bin/python" sh "$repo/scripts/install.sh" >/dev/null && [ "$(cat "$work/home/activation.log")" = 'luvebot enable' ] \
    || fail "explicit HERMES_PYTHON"
case_home
set +e; run bin-shell sh "$repo/scripts/install.sh" --nope >/dev/null 2>&1; code=$?; set -e
[ "$code" = 2 ] || fail "bad flag exit $code"
nothing_left 'bad flag'
echo "== bad flag: exit 2, nothing left"
echo "RUNTIME SELECTION: OK"
