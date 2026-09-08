#!/usr/bin/env bash
# Contract test for scripts/resolve-file-size-base.sh (DIVE-4090).
#
# Builds a synthetic fork -- an "upstream" line, our main forked from it -- and
# checks out four pull-request shapes the way actions/checkout does on a
# pull_request run: refs/pull/N/merge at fetch-depth 2 from a bare origin, so
# the PR head is a shallow boundary exactly as in CI.
#
#   plain feature branch             -> HEAD^1 (empty)
#   wholesale sync merge + a fix-up  -> the sync merge's upstream parent
#   feature branch that merged main  -> HEAD^1 (empty)
#   push event                       -> HEAD^1 (empty)
#
# The sync and merged-main shapes are then re-run from a full clone, which
# exercises the no-fetch path and the ancestry test instead of the
# absent-after-shallow-exclude inference.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
resolve="${repo_root}/scripts/resolve-file-size-base.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

g() { git -C "$1" -c user.name=test -c user.email=test@example.com "${@:2}"; }
commit() {
  echo "$2" >>"$1/file-$2"
  g "$1" add -A
  g "$1" commit -qm "$2"
}

src="$tmp/src"
bare="$tmp/origin.git"
mkdir -p "$src"
g "$src" init -q -b main
commit "$src" u1
g "$src" branch upstream
commit "$src" o1
g "$src" checkout -q upstream
commit "$src" u2
commit "$src" u3
upstream_tip=$(g "$src" rev-parse upstream)

# Shape A: plain feature branch off main.
g "$src" checkout -q -b feat main
commit "$src" f1

# Shape B: wholesale sync -- merge upstream into a branch off main, fix-up on top.
g "$src" checkout -q -b sync main
g "$src" merge -q --no-ff -m "sync upstream" upstream
commit "$src" fixup

# Shape C: feature branch that merged main into itself after main moved.
g "$src" checkout -q -b feat2 main
commit "$src" f2
g "$src" checkout -q main
commit "$src" o2
g "$src" checkout -q feat2
g "$src" merge -q --no-ff -m "merge main" main

# GitHub's refs/pull/N/merge: a merge of the base tip and the PR head.
mergeref() {
  g "$src" checkout -q --detach main
  g "$src" merge -q --no-ff -m "pull request merge ref for $1" "$1" >/dev/null
  g "$src" update-ref "refs/pull/$2/merge" HEAD
}
mergeref feat 1
mergeref sync 2
mergeref feat2 3

git clone -q --bare "$src" "$bare"
g "$src" push -q "$bare" "refs/pull/*:refs/pull/*"
git -C "$bare" config uploadpack.allowReachableSHA1InWant true
git -C "$bare" config uploadpack.allowFilter true

# name pull-ref event expected
run_case() {
  local work="$tmp/work-$1" envfile out got
  mkdir -p "$work"
  git -C "$work" init -q
  git -C "$work" remote add origin "$bare"
  git -C "$work" fetch -q --depth=2 origin "+$2:refs/remotes/origin/pr-merge"
  git -C "$work" checkout -q --detach refs/remotes/origin/pr-merge
  [ "$(git -C "$work" rev-parse --is-shallow-repository)" = "true" ] ||
    { echo "case $1: checkout is not shallow, test would not cover the CI shape" >&2; exit 1; }
  envfile="$work/github.env"
  : >"$envfile"
  out=$(cd "$work" && GITHUB_EVENT_NAME="$3" GITHUB_BASE_REF=main GITHUB_ENV="$envfile" "$resolve")
  got=$(sed -n 's/^CHECK_FILE_SIZES_BASE=//p' "$envfile")
  [[ "$out" == ratchet-base:* ]] ||
    { echo "case $1: no ratchet-base receipt line (got: $out)" >&2; exit 1; }
  [ "$got" = "$4" ] ||
    { echo "case $1: expected base '$4', got '$got' ($out)" >&2; exit 1; }
  echo "ok $1: $out"
}

run_case plain-feature refs/pull/1/merge pull_request ""
run_case sync-with-fixup refs/pull/2/merge pull_request "$upstream_tip"
run_case feature-merged-main refs/pull/3/merge pull_request ""
run_case push-event refs/pull/2/merge push ""

# Full-history path: no shallow fetch, ancestry decided by merge-base.
run_full() {
  local work="$tmp/full-$1" envfile out got
  git -c advice.detachedHead=false clone -q "$bare" "$work"
  git -C "$work" fetch -q origin "+$2:refs/remotes/origin/pr-merge"
  git -C "$work" -c advice.detachedHead=false checkout -q --detach refs/remotes/origin/pr-merge
  envfile="$work/github.env"
  : >"$envfile"
  out=$(cd "$work" && GITHUB_EVENT_NAME=pull_request GITHUB_BASE_REF=main GITHUB_ENV="$envfile" "$resolve")
  got=$(sed -n 's/^CHECK_FILE_SIZES_BASE=//p' "$envfile")
  [ "$got" = "$3" ] ||
    { echo "full $1: expected base '$3', got '$got' ($out)" >&2; exit 1; }
  echo "ok full-history $1: $out"
}
run_full sync-with-fixup refs/pull/2/merge "$upstream_tip"
run_full feature-merged-main refs/pull/3/merge ""

echo "resolve-file-size-base contract: all cases passed"
