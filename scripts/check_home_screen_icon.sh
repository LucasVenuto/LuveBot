#!/bin/sh
# What an iPhone gets when someone adds LuveBot to the Home Screen: it reads the manifest and fetches each icon WITHOUT your cookies.
# This asks for the same files the same way (no cookie, no login, no redirect followed) and says what is wrong. Read only: it only GETs static files.
#   scripts/check_home_screen_icon.sh https://your-host            (or https://your-host/prefix, when a proxy mounts the dashboard under a path)
set -u
base=${1:?usage: $0 https://your-host[/prefix]}; base=${base%/}
dir="$base/dashboard-plugins/luvebot"
bad=0
get() { curl -sS -o "${2:-/dev/null}" -m 15 --max-redirs 0 -A "CFNetwork/1494.0.7 Darwin/23.4.0" -w "%{http_code} %{content_type}" "$1" 2>&1; }
check() {  # url, expected content type, what it means when it fails
  out=$(get "$1") || { echo "FAIL  $1  ($out)"; bad=1; return; }
  case "$out" in "200 $2"*) echo "ok    $1  $out";; *) echo "FAIL  $1  $out  <- $3"; bad=1;; esac
}
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
out=$(get "$dir/pwa.json" "$tmp") || { echo "FAIL  $dir/pwa.json  ($out)"; exit 1; }
case "$out" in "200 application/json"*) echo "ok    $dir/pwa.json  $out";; *) echo "FAIL  $dir/pwa.json  $out  <- the manifest is not served without a login"; exit 1;; esac
check "$dir/icons/apple-touch-icon.png" image/png "this is the icon the iPhone asks for: without it the Home Screen gets a letter on a dark tile"
for src in $(grep -o '"src"[^,}]*' "$tmp" | sed 's/.*: *"\(.*\)"/\1/'); do
  case "$src" in
    /*) echo "FAIL  $src  <- an absolute address ignores the proxy prefix: use one relative to the manifest (icons/...)"; bad=1; continue;;
    *.svg) echo "FAIL  $src  <- an iPhone cannot draw an SVG icon: list PNG only"; bad=1; continue;;
  esac
  check "$dir/$src" image/png "this icon is not reachable without a login"
done
[ "$bad" = 0 ] && echo "ALL GOOD: an iPhone with no cookie gets the manifest and every icon." || echo "SOMETHING IS WRONG: see the FAIL lines above."
exit $bad
