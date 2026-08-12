#!/usr/bin/env bash
# DIVE-3300 — live NIP-AB pairing round-trip proving what goes ON THE WIRE.
#
# Stdin discipline (learned the hard way, DIVE-3152): FIFOs with a held-open
# writer. Never `< /dev/null` — EOF ANSWERS the source's [y/n] prompt with "no"
# and fabricates a SAS mismatch. Never `yes |` — that pre-commits to certifying
# a match nobody compared. This script compares the two SAS codes itself and
# only then writes "y".
set -uo pipefail

BIN=${BIN:?set BIN to the target/debug dir}
RUN=$(dirname "$0")
PORT=${PORT:-5099}
RELAY_WS="ws://127.0.0.1:${PORT}"
ENVELOPE_RELAY=${ENVELOPE_RELAY:-https://relay.example.com}
MODE=${MODE:-envelope}   # envelope | bare

rm -f "$RUN"/src.log "$RUN"/tgt.log "$RUN"/src.in "$RUN"/tgt.in
mkfifo "$RUN"/src.in "$RUN"/tgt.in

cleanup() { kill ${SRC_PID:-} ${TGT_PID:-} ${RELAY_PID:-} 2>/dev/null; exec 3>&- 4>&- 2>/dev/null; }
trap cleanup EXIT

# --- known key, so we can assert the exact nsec and pubkey that came out ---
NSEC=${NSEC:?set NSEC}

BUZZ_PAIR_RELAY_BIND_ADDR=127.0.0.1:$PORT "$BIN/buzz-pair-relay" >"$RUN"/relay.log 2>&1 &
RELAY_PID=$!
for _ in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && break; sleep 0.1; done

SRC_ARGS=(source --relay "$RELAY_WS" --nsec "$NSEC")
[ "$MODE" = envelope ] && SRC_ARGS+=(--envelope-relay "$ENVELOPE_RELAY")

"$BIN/buzz-pair" "${SRC_ARGS[@]}" <"$RUN"/src.in >"$RUN"/src.log 2>&1 &
SRC_PID=$!
exec 3>"$RUN"/src.in            # hold the source's stdin open

wait_for() { # file regex timeout_deciseconds
  for _ in $(seq 1 "$3"); do grep -qE "$2" "$1" 2>/dev/null && return 0; sleep 0.1; done
  echo "TIMEOUT waiting for /$2/ in $1"; sed -e 's/^/    | /' "$1"; return 1
}

wait_for "$RUN"/src.log 'nostrpair://' 300 || exit 1
QR=$(grep -oE 'nostrpair://[^[:space:]]+' "$RUN"/src.log | head -1)
echo "QR: ${QR:0:60}..."

"$BIN/buzz-pair" target --show-secret <"$RUN"/tgt.in >"$RUN"/tgt.log 2>&1 &
TGT_PID=$!
exec 4>"$RUN"/tgt.in            # hold the target's stdin open
printf '%s\n' "$QR" >&4

wait_for "$RUN"/tgt.log 'SAS code:' 300 || exit 1
wait_for "$RUN"/src.log 'SAS code:' 300 || exit 1
SAS_SRC=$(grep -oE 'SAS code: [0-9]+' "$RUN"/src.log | head -1 | awk '{print $3}')
SAS_TGT=$(grep -oE 'SAS code: [0-9]+' "$RUN"/tgt.log | head -1 | awk '{print $3}')
echo "SAS source=$SAS_SRC target=$SAS_TGT"
if [ -z "$SAS_SRC" ] || [ "$SAS_SRC" != "$SAS_TGT" ]; then
  echo "SAS MISMATCH OR MISSING — answering n, not y"; printf 'n\n' >&4 >&3; exit 1
fi
printf 'y\n' >&3                # only after WE compared them
# The target prompts too, after it has the source's sas-confirm.
wait_for "$RUN"/tgt.log 'Does your source device show' 300 || exit 1
printf 'y\n' >&4

wait_for "$RUN"/tgt.log 'Received .* payload' 600 || exit 1
sleep 1
echo "=== source ==="; cat "$RUN"/src.log
echo "=== target ==="; cat "$RUN"/tgt.log
