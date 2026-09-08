#!/usr/bin/env bash
# Resolve the base commit for `just file-size-check` and export it as
# CHECK_FILE_SIZES_BASE (appended to $GITHUB_ENV on Actions, printed elsewhere).
#
# Why this exists (DIVE-3850, DIVE-4069, DIVE-4090): the file-size ratchet
# diffs the tree against HEAD^1. On an ordinary PR that is the base branch tip
# and the diff is the author's own work. On a weekly wholesale upstream sync
# the PR carries a merge commit whose second parent is upstream's tip, and
# HEAD^1 is our PRE-merge main -- so the ratchet reads every upstream commit
# since the last sync as this PR's diff and false-reds on files with zero
# lines of ours. The correct base for that shape is the sync merge's UPSTREAM
# parent (measured on one tree with only the base changing: HEAD^1 rc=1,
# merge-base rc=1, upstream parent rc=0).
#
# Two earlier fixes keyed this on the BRANCH NAME and pasted the sha by hand.
# A name predicate that misses is a silently disengaged guard (week 4), one
# that over-matches false-reds an ordinary feature branch, and a pasted sha is
# stale the week after it was written. This script reads the base off the
# MERGE ITSELF:
#
#   1. Only a pull_request run has a merge ref to inspect: HEAD is GitHub's
#      merge of the base tip (HEAD^1) and the PR head (HEAD^2).
#   2. The checkout is depth 2, so the PR head is a shallow boundary and its
#      own history is absent. Fetch exactly the PR's commits -- everything
#      reachable from the head that is NOT reachable from the base branch
#      (--shallow-exclude) -- as trees only (--filter=blob:none; the ratchet
#      lazily pulls the handful of base blobs it actually reads).
#   3. Walk the PR's first-parent chain. The first merge commit on it whose
#      second parent is NOT on the base branch is a wholesale merge of a
#      foreign side; that second parent is the base. A shallow boundary
#      commit is grafted parentless, so parents are read from the raw object.
#   4. Anything else -- a plain feature branch, or a branch that merged the
#      base branch into itself -- keeps HEAD^1 (empty value), unchanged.
#
# The single `ratchet-base:` line this prints is the receipt: read it in the
# job log to see which base a given PR actually got, and why.
set -euo pipefail

emit() {
  if [ -n "${GITHUB_ENV:-}" ]; then
    printf 'CHECK_FILE_SIZES_BASE=%s\n' "$1" >>"$GITHUB_ENV"
  else
    printf 'CHECK_FILE_SIZES_BASE=%s\n' "$1"
  fi
}

receipt() {
  printf 'ratchet-base: %s\n' "$1"
}

event="${GITHUB_EVENT_NAME:-}"
if [ "$event" != "pull_request" ]; then
  receipt "HEAD^1 (event '${event:-none}' is not a pull request; nothing to derive)"
  emit ""
  exit 0
fi

if ! head=$(git rev-parse --verify --quiet 'HEAD^2'); then
  receipt "HEAD^1 (HEAD has one parent, so this checkout is not a pull-request merge ref)"
  emit ""
  exit 0
fi
base_tip=$(git rev-parse 'HEAD^1')
base_ref="${GITHUB_BASE_REF:-main}"

if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  if ! git fetch --quiet --filter=blob:none --shallow-exclude="$base_ref" origin "$head"; then
    echo "::error::resolve-file-size-base: could not fetch this PR's commits" \
      "(git fetch --shallow-exclude=$base_ref origin $head failed); refusing to guess the base" >&2
    exit 1
  fi
fi

chain=$(git rev-list --first-parent "$head" --not "$base_tip")
count=$(printf '%s\n' "$chain" | grep -c . || true)

for commit in $chain; do
  # Raw parents: `git rev-parse <c>^2` fails on a shallow boundary commit, but
  # the commit object itself still lists every parent.
  parents=$(git cat-file -p "$commit" | sed -n 's/^parent //p')
  second=$(printf '%s\n' "$parents" | sed -n '2p')
  [ -n "$second" ] || continue

  if ! git cat-file -e "${second}^{commit}" 2>/dev/null; then
    # Absent after a fetch that excluded the base branch => reachable from the
    # base branch => this merge brought the base branch in, not a foreign side.
    on_base=true
  elif git merge-base --is-ancestor "$second" "$base_tip"; then
    on_base=true
  else
    on_base=false
  fi

  if [ "$on_base" = "true" ]; then
    receipt "HEAD^1 (merge commit ${commit:0:9} on this PR merges the base branch in, not a foreign side; ${count} first-parent commit(s) on this PR)"
    emit ""
    exit 0
  fi

  receipt "${second} (second parent of merge commit ${commit:0:9}, the foreign side of a wholesale merge; ${count} first-parent commit(s) on this PR)"
  emit "$second"
  exit 0
done

receipt "HEAD^1 (no merge commit among this PR's ${count} first-parent commit(s))"
emit ""
