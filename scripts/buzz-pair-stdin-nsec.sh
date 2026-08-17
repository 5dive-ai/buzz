#!/usr/bin/env bash
# DIVE-3553 — grade `buzz-pair source --nsec -` (key on stdin, never argv).
#
# Every arm is a measurement, not an assertion about the source: the binary is
# run, and what it printed / what its /proc/PID/cmdline held is read back.
#
#   usage: scripts/buzz-pair-stdin-nsec.sh <buzz-pair-under-test> [buzz-pair-cli-v0.1.0]
#
# The second argument is the REFUSAL CONTROL: the released cli-v0.1.0 binary,
# which must FAIL the help probe the 5dive CLI uses (tests/buzz_pair_unit.sh,
# `_buzz_pair_supports_stdin_nsec`). Without it a probe that matches everything
# would score as a pass.
set -uo pipefail

BIN="${1:?usage: $0 <buzz-pair> [buzz-pair-cli-v0.1.0]}"
CONTROL="${2:-}"
pass=0; fail=0
ok()   { printf 'PASS  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf 'FAIL  %s\n' "$1"; fail=$((fail+1)); }
check(){ if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want '$3', got '$2')"; fi; }

# A throwaway key: the NIP-AB spec's own published `source_priv` vector, bech32
# encoded here so the arms feed exactly the `nsec1…` shape the 5dive CLI feeds.
# No real key is ever used by this harness.
HEX=$("$BIN" test-vectors 2>/dev/null | awk -F'|' '/source_priv/ {gsub(/ /,"",$3); print $3}')
[[ "$HEX" =~ ^[0-9a-f]{64}$ ]] || { echo "setup: no source_priv vector from $BIN"; exit 2; }
NSEC=$(python3 - "$HEX" <<'PY'
import sys
C="qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def poly(v):
    g=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3]; c=1
    for d in v:
        b=c>>25; c=((c&0x1ffffff)<<5)^d
        for i in range(5):
            c^=g[i] if (b>>i)&1 else 0
    return c
def conv(data):
    acc=bits=0; out=[]
    for b in data:
        acc=(acc<<8)|b; bits+=8
        while bits>=5: bits-=5; out.append((acc>>bits)&31)
    if bits: out.append((acc<<(5-bits))&31)
    return out
hrp="nsec"; data=conv(bytes.fromhex(sys.argv[1]))
exp=[ord(c)>>5 for c in hrp]+[0]+[ord(c)&31 for c in hrp]
chk=poly(exp+data+[0,0,0,0,0,0])^1
print(hrp+"1"+"".join(C[d] for d in data+[(chk>>5*(5-i))&31 for i in range(6)]))
PY
) || NSEC="$HEX"
[[ -n "$NSEC" ]] || { echo "setup: could not mint a test nsec"; exit 2; }
[[ "$NSEC" == nsec1* ]] || echo "note: falling back to the hex form of the test key"

# A relay that refuses instantly: the run must die at CONNECT, which is proof
# the key parsed. --nsec is validated before any session I/O.
DEAD="wss://127.0.0.1:1"

# ---------------------------------------------------------------- help probe
# Verbatim copy of the 5dive CLI's `_buzz_pair_supports_stdin_nsec` predicate.
probe() {
  local help; help=$("$1" source --help 2>&1) || return 1
  grep -Eq -- "--nsec.*(stdin|'-'|\"-\")" <<<"$help" \
    || grep -Eqi 'reads? the (key|nsec) from stdin' <<<"$help"
}
if probe "$BIN"; then ok "help names the stdin form (5dive CLI's probe accepts it)"
else bad "help does not name the stdin form — the 5dive CLI will refuse this build"; fi

if [[ -n "$CONTROL" ]]; then
  if probe "$CONTROL"; then bad "CONTROL: cli-v0.1.0 help passed the probe — the probe matches anything"
  else ok "CONTROL: cli-v0.1.0 help fails the probe (the refusal it is supposed to fire)"; fi
fi

# ------------------------------------------------------- key travels on stdin
out=$(printf '%s\n' "$NSEC" | "$BIN" source --nsec - --relay "$DEAD" 2>&1)
if grep -q 'invalid nsec' <<<"$out"; then
  bad "stdin key was not consumed: $(grep -m1 'invalid nsec' <<<"$out")"
elif grep -qE 'error: (WebSocket|I/O)' <<<"$out"; then
  ok "stdin key parsed; run died at CONNECT, not at parse"
else
  bad "unexpected outcome for a good stdin key: $(tail -2 <<<"$out" | tr '\n' ' ')"
fi

# The QR URI is minted from the resolved payload, so its presence says the
# payload resolved at all.
grep -q '^nostrpair://' <<<"$out" && ok "session minted a QR URI from the stdin key" \
  || bad "no QR URI — payload never resolved"

# --------------------------------------------- negative controls on that path
# Garbage on stdin must be REJECTED, not silently replaced by a generated key.
out=$(printf 'not-an-nsec\n' | "$BIN" source --nsec - --relay "$DEAD" 2>&1)
grep -q 'invalid nsec' <<<"$out" && ok "CONTROL: junk on stdin is rejected as invalid nsec" \
  || bad "CONTROL: junk on stdin was accepted: $(tail -1 <<<"$out")"

# Empty stdin is the case that silently pairs the handset to the WRONG key if
# `-` were to fall through to the generate-a-test-key branch.
out=$(printf '' | "$BIN" source --nsec - --relay "$DEAD" 2>&1)
grep -q 'invalid nsec' <<<"$out" && ok "CONTROL: empty stdin is rejected, not swapped for a generated key" \
  || bad "CONTROL: empty stdin did not fail closed: $(tail -1 <<<"$out")"

# A literal nsec in argv must still work — this patch may not break the old form.
out=$("$BIN" source --nsec "$NSEC" --relay "$DEAD" </dev/null 2>&1)
grep -qE 'error: (WebSocket|I/O)' <<<"$out" && ok "argv form still works (no regression)" \
  || bad "argv form regressed: $(tail -1 <<<"$out")"

# No --nsec at all still generates a key.
out=$("$BIN" source --relay "$DEAD" </dev/null 2>&1)
grep -q 'no --nsec provided' <<<"$out" && ok "absent --nsec still generates a test key" \
  || bad "absent --nsec regressed: $(tail -1 <<<"$out")"

# --------------------------------------------------- the actual leak, measured
# Stage the documented invocation against a relay that HANGS (unroutable, so the
# connect sits) and read /proc/PID/cmdline while it is alive. A fixture string is
# not evidence; the kernel's copy of argv is.
HANG="wss://10.255.255.1:443"
leakcheck() { # <label> <want-leak: yes|no> <args...>
  local label="$1" want="$2"; shift 2
  local pid cmdline=""
  { printf '%s\n' "$NSEC"; sleep 6; } | "$BIN" "$@" >/dev/null 2>&1 &
  pid=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -r "/proc/$pid/cmdline" ]] && cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline") && break
    sleep 0.2
  done
  # The child of the pipeline is the shell's job; find the buzz-pair pid itself.
  local real; real=$(pgrep -f "buzz-pair.* source .*$(basename "$HANG")" 2>/dev/null | head -1)
  [[ -n "$real" && -r "/proc/$real/cmdline" ]] && cmdline=$(tr '\0' ' ' < "/proc/$real/cmdline")
  local got="no"; grep -qF "$NSEC" <<<"$cmdline" && got="yes"
  check "$label" "$got" "$want"
  [[ -n "$cmdline" ]] || bad "$label: /proc cmdline was empty — the arm measured nothing"
  kill "$pid" ${real:+"$real"} 2>/dev/null
  wait "$pid" 2>/dev/null
}
leakcheck "argv holds NO key with --nsec -" no  source --nsec - --relay "$HANG"
# POSITIVE CONTROL: the pre-fix shape. If this does not report a leak, the probe
# is blind and the arm above proves nothing.
leakcheck "CONTROL: argv DOES hold the key when passed literally" yes source --nsec "$NSEC" --relay "$HANG"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ "$fail" -eq 0 ]]
