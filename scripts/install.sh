#!/bin/sh
# Install into (or, with --uninstall, remove from) an existing Hermes environment; no packages or servers are created.
#   ./scripts/install.sh              copy the theme, enable the plugin
#   ./scripts/install.sh --uninstall  disable the plugin, remove the theme and this plugin directory (safe to repeat)
# The Python that runs Hermes is found and PROVEN (it must import hermes_cli.plugins_cmd) before anything is copied,
# enabled or removed; otherwise the script stops with a message and changes nothing. HERMES_PYTHON picks it by hand.
set -eu

# Everything lives in functions and main runs last: --uninstall deletes the directory this script sits in.
main() {
    project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
    hermes_home=${HERMES_HOME:-"$HOME/.hermes"}
    target="$hermes_home/plugins/luvebot"
    state_py="$project_dir/scripts/plugin_state.py"
    last_error=
    case "${1:-}" in
        '') find_runtime; install ;;
        --uninstall) find_runtime; uninstall ;;
        *) echo "Usage: $0 [--uninstall]" >&2; return 2 ;;
    esac
}

die() {
    printf 'LuveBot: %s\nNothing was installed, enabled or removed.\n' "$*" >&2
    exit 1
}

# Run scripts/plugin_state.py ACTION with the chosen runtime. Both launcher forms run a MODULE (that is their contract); the
# module is the standard library's cProfile, which runs one Python file (its statistics go to /dev/null).
#  python:   an interpreter that imports Hermes directly.
#  launcher: `hermes --run-module M ARGS`, the managed launcher running M with its own interpreter and bootstrap, the very
#            runtime of the `hermes` command (hermes_cli/_launchers.py _launcher_script; Hermes persists commands in this form,
#            installation_command).
#  hermes:   the launcher's reported runtime command (JSON argv from `hermes --print-runtime-command --module M`,
#            print_runtime_command, the "machine boundary for consumers holding the exact published launcher"), plus ARGS.
run_state() {
    if [ "$runtime" = python ]; then
        HERMES_HOME="$hermes_home" "$py" "$state_py" "$1"
    elif [ "$runtime" = launcher ]; then
        HERMES_HOME="$hermes_home" "$launcher" --run-module cProfile -o /dev/null "$state_py" "$1"
    else
        printf '%s' "$runtime_json" | HERMES_HOME="$hermes_home" "$py" -I -c '
import json, os, sys
argv = json.loads(sys.stdin.read())
if not (isinstance(argv, list) and argv and all(isinstance(a, str) and a for a in argv)):
    sys.exit("the Hermes launcher reported an invalid runtime command")
os.execv(argv[0], argv + sys.argv[1:])' -o /dev/null "$state_py" "$1"
    fi
}

# True when the chosen runtime imports Hermes's activation code; the last line it printed otherwise is kept for the message.
works() {
    if errors=$(run_state check 2>&1 >/dev/null); then return 0; fi
    last_error=$(printf '%s\n' "$errors" | sed '/^[[:space:]]*$/d' | tail -n 1 | cut -c1-200)
    return 1
}

# The interpreter named on a launcher's first line, only when that interpreter is a Python ("#!/path/python3",
# "#!/usr/bin/env python3"); nothing for "#!/bin/sh" and the like.
shebang_python() {
    line=$(head -n 1 "$1" 2>/dev/null) || return 1
    case $line in '#!'*) ;; *) return 1 ;; esac
    set -f
    # shellcheck disable=SC2086  (word splitting of the interpreter line is the point)
    set -- ${line#??}
    set +f
    [ $# -gt 0 ] || return 1
    if [ "${1##*/}" = env ]; then
        shift
        [ "${1:-}" != -S ] || shift
    fi
    [ $# -gt 0 ] || return 1
    case ${1##*/} in python*) printf '%s\n' "$1" ;; *) return 1 ;; esac
}

find_runtime() {
    if [ -n "${HERMES_PYTHON:-}" ]; then
        runtime=python py=$HERMES_PYTHON
        works || die "HERMES_PYTHON ($HERMES_PYTHON) cannot import Hermes's activation code (hermes_cli.plugins_cmd).${last_error:+ Last error: $last_error.} Point it at the Python of your Hermes installation, or unset it to let this script ask the 'hermes' command."
        return 0
    fi
    launcher=$(command -v hermes 2>/dev/null) || die "the 'hermes' command is not on PATH. Put it on PATH, or set HERMES_PYTHON to the Python of your Hermes installation."
    # 1. A Python launcher (a pip or venv console script): its first line names the interpreter.
    if py=$(shebang_python "$launcher"); then
        runtime=python
        works && return 0
    fi
    # 2. A shell launcher (Hermes's managed installs write "#!/bin/sh" + exec, hermes_cli/_launchers.py _write_shell):
    #    run through the launcher itself, then (older launchers) through the runtime command it reports.
    runtime=launcher
    works && return 0
    if runtime_json=$("$launcher" --print-runtime-command --module cProfile 2>/dev/null); then
        py=$(printf '%s\n' "$runtime_json" | sed -n 's/^\[ *"\([^"\\]*\)".*/\1/p' | head -n 1)
        case $py in
            /*) if [ -x "$py" ]; then runtime=hermes; works && return 0; fi ;;
        esac
    fi
    die "could not find the Python that runs Hermes from $launcher (it is neither a Python script nor a launcher that answers --run-module or --print-runtime-command).${last_error:+ Last error: $last_error.} Set HERMES_PYTHON to the Python of your Hermes installation and run this again."
}

# Use Hermes's activation transaction, not edits to its internal config files.
set_enabled() {
    if [ "$1" = 1 ]; then run_state enable; else run_state disable; fi
}

install() {
    [ -f "$project_dir/dashboard/dist/index.js" ] || { echo 'Build the dashboard bundle before installing.' >&2; return 1; }
    [ -f "$project_dir/theme/luve.yaml" ] || { echo 'LuveBot theme is missing.' >&2; return 1; }
    mkdir -p "$target/dashboard" "$target/backend" "$hermes_home/dashboard-themes"
    if [ "$(CDPATH= cd -- "$target" && pwd -P)" != "$project_dir" ]; then
        cp -R "$project_dir/dashboard/." "$target/dashboard/"
        cp -R "$project_dir/backend/." "$target/backend/"
    fi
    cp "$project_dir/theme/luve.yaml" "$hermes_home/dashboard-themes/luve.yaml"
    set_enabled 1
    run_state upgrade  # existing Bots: idempotent, audited, never over a hint the owner wrote (T12)
    printf '%s\n' 'LuveBot installed and enabled. Restart the Hermes dashboard to load it.'
}

uninstall() {
    set_enabled 0
    rm -f "$hermes_home/dashboard-themes/luve.yaml"
    cd / # never stay inside the directory about to be removed
    rm -rf "$target"
    printf '%s\n' "LuveBot disabled and removed. Restart the Hermes dashboard. Its data in $hermes_home/luvebot/ was kept."
}

main "$@"
exit $?
