#!/bin/zsh
# Runs the baseline and each mutation on the native (no Docker) harness. One stack at a time, sequentially. Never touches the repo tree.
# Usage: RUN=<native run.sh> H=<scratch root> WT=<worktree of main, clean> OUT=<log dir> run.zsh [names...]   (default: base + the three)
set -u
: ${H:?} ${WT:?} ${OUT:?}
HERE=${0:A:h}; RUN=${RUN:?path of the native harness run.sh}
if (( $# )); then names=($@); else names=(base t83d_image_accepted luve_any_value me_no_csrf); fi
mkdir -p $OUT
for n in $names; do
  git -C $WT checkout -q -- . || exit 2
  ids=$(python3 $HERE/apply.py $WT $n 2>$OUT/$n.apply) || { echo "$n: anchor/syntax FAIL"; cat $OUT/$n.apply; exit 2; }
  echo "== $n: $(cat $OUT/$n.apply | tr -d '\n') -> $(echo $ids | wc -w | tr -d ' ') test id(s)"
  git -C $WT diff --stat > $OUT/$n.diffstat; git -C $WT diff -U0 > $OUT/$n.diff
  H=$H WT=$WT SUITES="$ids" RAW=1 LINES_PER_SUITE=80 zsh $RUN > $OUT/$n.log 2>&1
  echo "   exit=$? :: $(grep -E '[0-9]+ (passed|failed)' $OUT/$n.log | tr '\n' ' ')"
done
git -C $WT checkout -q -- .
echo "worktree restored: $(git -C $WT status --short | wc -l | tr -d ' ') changed files"
