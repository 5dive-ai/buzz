#!/usr/bin/env bash
# Install the buzz CLI onto a box, from a published release of this repository.
#
# This is the distribution path for DIVE-3512. The control plane's per-agent
# buzz config names "buzz_path": "/usr/local/bin/buzz", and `5dive agent buzz
# status <name>` resolves the binary from the agent's PATH, /usr/local/bin/buzz
# or /opt/buzz/bin/buzz. Installing here is what turns that check from rc 3
# into rc 0.
#
#   curl -fsSL https://raw.githubusercontent.com/5dive-ai/buzz/main/scripts/install-buzz-cli.sh | sudo bash -s -- --tag cli-v0.1.0
#
# or, from a checkout:
#
#   sudo ./scripts/install-buzz-cli.sh --tag cli-v0.1.0
#
# WHY IT VERIFIES BEFORE IT INSTALLS: an unattributed binary at
# /usr/local/bin/buzz is worse than no binary — nothing ties it to a commit, so
# nothing can say what it does. Every release carries SHA256SUMS and a
# PROVENANCE.txt naming the commit, the workflow run, and each binary's
# BuildID. This script refuses to install if the download does not match
# SHA256SUMS, and it prints the provenance it installed so the box's own logs
# record which build landed.

set -euo pipefail

REPO="${BUZZ_REPO:-5dive-ai/buzz}"
PREFIX="${PREFIX:-/usr/local/bin}"
TAG=""
FORCE="false"

die() { printf 'install-buzz-cli: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="${2:-}"; shift 2 ;;
    --tag=*) TAG="${1#*=}"; shift ;;
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    --force) FORCE="true"; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$TAG" ]] || die "a release tag is required (--tag cli-v0.1.0). Refusing to guess: 'latest' would make the installed build unnameable, which is the defect this script exists to prevent."

command -v curl >/dev/null || die "curl is required"
command -v sha256sum >/dev/null || die "sha256sum is required"

# Named target, printed, so a wrong-target success cannot be invisible.
BASE="https://github.com/${REPO}/releases/download/${TAG}"
printf 'Installing buzz CLI\n'
note "repository: ${REPO}"
note "tag:        ${TAG}"
note "prefix:     ${PREFIX}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

for f in buzz buzz-pair SHA256SUMS PROVENANCE.txt; do
  curl -fsSL --retry 3 -o "${WORK}/${f}" "${BASE}/${f}" \
    || die "could not download ${f} from ${BASE} — check that ${TAG} exists and carries this asset"
done

# Verify BEFORE anything is copied into place. A failure here must leave the
# box exactly as it was.
( cd "$WORK" && sha256sum --check --status SHA256SUMS ) \
  || die "checksum mismatch — the downloaded binaries do not match the release's SHA256SUMS. Nothing was installed."

printf '\nProvenance of what is about to be installed:\n'
sed 's/^/  /' "${WORK}/PROVENANCE.txt"

for b in buzz buzz-pair; do
  dest="${PREFIX}/${b}"
  if [[ -e "$dest" && "$FORCE" != "true" ]]; then
    existing_id="$(readelf -n "$dest" 2>/dev/null | awk '/Build ID/ {print $3}')"
    die "${dest} already exists (BuildID ${existing_id:-unknown}). Refusing to overwrite: an existing binary may be hand-built and in use. Re-run with --force once you have established what it is."
  fi
done

install -d -m 0755 "$PREFIX"
for b in buzz buzz-pair; do
  install -m 0755 "${WORK}/${b}" "${PREFIX}/${b}"
done

# Record what landed, on the box, so a later reader does not have to ask us.
install -d -m 0755 /var/lib/buzz
cp "${WORK}/PROVENANCE.txt" /var/lib/buzz/installed-provenance.txt
printf 'installed_tag: %s\ninstalled_at:  %s\n' "$TAG" "$(date -u +%FT%TZ)" \
  >> /var/lib/buzz/installed-provenance.txt

printf '\nInstalled:\n'
for b in buzz buzz-pair; do
  note "${PREFIX}/${b}  ($("${PREFIX}/${b}" --version 2>/dev/null || echo 'version unavailable'))"
done
note "provenance recorded at /var/lib/buzz/installed-provenance.txt"

printf '\nNext: 5dive agent buzz status <name> should now report "buzz binary: yes (%s/buzz)" and exit 0.\n' "$PREFIX"
