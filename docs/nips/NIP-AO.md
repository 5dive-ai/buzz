NIP-AO
======

Agent Observability
-------------------

`draft` `optional`

This NIP defines ephemeral, encrypted event kinds for streaming internal session telemetry between AI agent processes and their owners' desktop clients via Nostr relays.

## Motivation

AI agent harnesses execute long-running sessions that invoke tools, send protocol
frames to models, and emit intermediate reasoning. Owners need real-time visibility
into this activity for debugging, auditing, and control — without that telemetry
being stored on any relay or visible to third parties.

Kind 24200 provides a dedicated, encrypted, ephemeral channel for this purpose.
It is strictly scoped to the agent↔owner relationship and carries no durable state.

## Definitions

- **Agent**: An AI process with its own Nostr keypair, executing a session on behalf of an owner.
- **Owner**: The human (or system) whose pubkey the agent was provisioned under.
- **Observer Frame**: A single kind 24200 event carrying one unit of telemetry or control.
- **Session**: A bounded agent execution correlated by a shared `sessionId`.
- **Request nonce**: A single-use random token bound to one `session/request_permission`
  call. The harness generates it on arrival of the request, embeds it in the
  `authorization` envelope of the emitted `acp_read` telemetry frame, and consumes it
  exactly once when a matching `permission_decision` control frame is received. A nonce
  that is never matched expires with the per-request fail-closed timeout.

## Event Kinds

| Kind  | Name                  | Direction         |
|-------|-----------------------|-------------------|
| 24200 | Agent Observer Frame  | agent↔owner (both)|

Kind 24200 falls in the ephemeral range (20000–29999) defined by NIP-01. Relays
MUST NOT persist it.

## Event Structure

```json
{
  "kind": 24200,
  "pubkey": "<sender_pubkey>",
  "created_at": <unix_timestamp>,
  "content": "<NIP-44 v2 ciphertext>",
  "tags": [
    ["p",     "<recipient_pubkey>"],
    ["agent", "<agent_pubkey>"],
    ["frame", "telemetry" | "control"]
  ]
}
```

Events MUST have exactly one `p` tag, exactly one `agent` tag, and exactly one
`frame` tag.

**Telemetry** (agent → owner): `pubkey`=agent, `p`=owner, `agent`=agent.
**Control** (owner → agent): `pubkey`=owner, `p`=agent, `agent`=agent (target).

`frame` MUST be `"telemetry"` or `"control"`. Relays SHOULD silently drop events
with unrecognized `frame` values (returning OK to the publisher for forward
compatibility). Clients MUST ignore events with unrecognized `frame` values. An `h`
tag MAY be included when the session runs within a NIP-29 group context.

## Encryption

All `content` fields MUST be encrypted with NIP-44 v2 (XChaCha20-Poly1305 over a
secp256k1 ECDH shared secret).

- **Telemetry**: encrypted with `(agent_privkey, owner_pubkey)`
- **Control**: encrypted with `(owner_privkey, agent_pubkey)`

Plaintext SHOULD be zeroized from memory immediately after encrypt/decrypt.
Decrypted payload MUST NOT exceed 65,535 bytes.

## Decrypted Payload

### Telemetry (`frame=telemetry`)

The `content` field decrypts to an `ObserverEvent` JSON object:

```json
{
  "seq":           <monotonic_integer>,
  "timestamp":     "<rfc3339_string>",
  "kind":          "<frame_kind>",
  "agentIndex":    <integer> | null,
  "channelId":     "<channel_uuid>" | null,
  "sessionId":     "<session_id>" | null,
  "turnId":        "<turn_id>" | null,
  "authorization": { ... } | omitted,
  "payload":       { ... }
}
```

`seq`, `timestamp`, `kind`, and `payload` are REQUIRED. `agentIndex`, `channelId`, `sessionId`,
and `turnId` are OPTIONAL — they MAY be `null` when the value is not yet known
(e.g., `sessionId` before session establishment). Clients MUST handle `null` values
gracefully.

`seq` is monotonically increasing per session (drop detection). `timestamp` is an
RFC 3339 datetime string with sub-second precision (e.g., `"2026-04-29T12:00:41.500Z"`).
`agentIndex` identifies the agent in multi-agent scenarios. `sessionId`/`turnId`
correlate frames across a session and turn. `payload` carries the raw ACP JSON frame
byte-for-byte — it is NEVER mutated by the harness. Unknown `kind` values MUST be
ignored.

`authorization` is present only on `acp_read` and `acp_write` frames that correspond
to `session/request_permission` calls (see [Authorization Envelope](#authorization-envelope)
below). It is omitted on all other frame kinds.

### Frame Kinds

| `kind`             | Description                                                        |
|--------------------|--------------------------------------------------------------------|
| `acp_read`         | Inbound ACP protocol frame (model → harness)                       |
| `acp_write`        | Outbound ACP protocol frame (harness → model)                      |
| `turn_started`     | A new agent turn has begun                                         |
| `session_resolved` | Session completed or terminated                                    |
| `control_result`   | Acknowledgement telemetry emitted after processing a control frame |

Permission `acp_read` frames (carrying `session/request_permission` calls) always
include an `authorization` envelope. The corresponding `acp_write` (the harness
response) also includes an `authorization` envelope correlated by the same nonce —
this pairs the challenge and answer in the observer log.

**One-write / one-observe contract.** Each pending permission entry produces at most
one ACP wire write and at most one authorized `acp_write` observer event. The write
and the observer event are always emitted together; if the write fails the observer
event is suppressed. The sole exception is the `uncertain` terminal (see below) in
which neither is emitted.

### Authorization Envelope

When an `acp_read` or `acp_write` frame relates to a `session/request_permission`
call, the `ObserverEvent` carries an `authorization` field:

```json
{
  "requestNonce": "<single-use opaque string>",
  "actionable":   true | false,
  "reason":       "<terminal-reason>" | omitted
}
```

- `requestNonce`: a single-use random token generated by the harness for this request.
  It is embedded in the `acp_read` emit and MUST be echoed verbatim in the
  `permission_decision` control frame sent by the desktop. The harness consumes the
  nonce exactly once — a second `permission_decision` carrying the same nonce is
  silently ignored. If no matching decision arrives before the per-request timeout,
  the harness fails the request closed.
- `actionable`: `true` when the owner can act (policy=`ask`, preflight passed, owner
  and observer available). `false` for auto-deny, fail-closed, and terminal outcomes.
- `reason`: present on every `acp_write` authorization envelope. Identifies the
  terminal outcome for this request. Defined values:

  | Value | Meaning |
  |-------|---------|
  | `"applied"` | Owner decision was received and written to the agent pipe. |
  | `"timed_out"` | No decision arrived before the 300-second per-request deadline; request failed closed (denial). |
  | `"cancelled"` | The turn was cancelled while the request was pending; request failed closed (denial). |

  The `uncertain` terminal (cancel arriving while the write is in flight) does NOT
  produce an `acp_write` observer event — the process is irrecoverably poisoned and
  will be respawned by the pool. Desktop clients MUST NOT expect an `acp_write` for
  every `acp_read` they receive; a missing `acp_write` after a `session_resolved`
  frame with a poisoned outcome indicates the `uncertain` path.

**Nonce binding.** The nonce is bound to the agent, channel, session, turn, request
ID, and exact option snapshot at generation time. It MUST NOT be reused across
requests, turns, or sessions. The harness rejects a `permission_decision` whose nonce
does not match any live pending entry.

### Control (`frame=control`)

The `content` field decrypts to a JSON object with a required `type` field.
Implementations MUST ignore events with unrecognized `type` values.

#### `cancel_turn`

Cancel the in-flight agent turn for the given channel.

```json
{
  "type":      "cancel_turn",
  "channelId": "<channel_uuid>"
}
```

#### `switch_model`

Switch the active model for the agent session in the given channel.

- **Busy turn:** delivers `ControlSignal::SwitchModel` over the per-turn oneshot,
  which triggers the harness to cancel the current turn and requeue with the new model.
  If the oneshot is already consumed (a prior cancel/interrupt is in flight), the
  switch cannot land and the current turn is left to complete with the old model.
- **Idle session:** validates the model against the cached catalog and, if valid,
  invalidates and reapplies the agent's model config immediately.

```json
{
  "type":      "switch_model",
  "channelId": "<channel_uuid>",
  "modelId":   "<model_identifier>"
}
```

#### `permission_decision`

Deliver the owner's decision for a pending `session/request_permission` call.
The harness matches `requestNonce` to a live pending entry and, if found, transitions
the entry from `pending` to `writing` and writes the ACP response.

```json
{
  "type":         "permission_decision",
  "channelId":    "<channel_uuid>",
  "requestNonce": "<nonce from the acp_read authorization envelope>",
  "optionId":     "<chosen option id from the original request>"
}
```

The harness MUST:
1. Verify `requestNonce` matches a live pending entry (else ignore silently).
2. Verify `optionId` is present in the exact option snapshot recorded at nonce
   generation time (else ignore silently — prevents replay with an altered option).
3. Transition the entry to `writing` atomically before performing the ACP write.
4. Emit an `acp_write` telemetry frame with a matching `authorization` envelope only
   after the write is confirmed.

**Best-effort delivery.** `permission_decision` frames ride the ordinary observer
control path — they are NOT guaranteed to arrive before the per-request timeout.
If no matching `permission_decision` is received within `min(300s, remaining hard
deadline)`, the harness fails the request closed (deny). The owner SHOULD respond
before this deadline; the desktop MAY surface the deadline to the owner in the
permission card UI.

### `control_result` Telemetry

After processing any control frame, the harness emits a `control_result` telemetry
event to confirm receipt. This is an `acp_read`-style telemetry frame (kind =
`control_result`) that carries a `payload` describing the outcome:

**`cancel_turn`:**
```json
{ "type": "cancel_turn", "status": "sent" | "no_active_turn" }
```

**`switch_model`:**
```json
{ "type": "switch_model", "status": "sent" | "turn_ending" | "switched" | "unsupported_model" | "no_active_turn", "modelId": "..." }
```

**`permission_decision`:**
```json
{
  "type":         "permission_decision",
  "status":       "sent" | "no_active_turn" | "channel_full" | "channel_closed" | "no_channel",
  "requestNonce": "<nonce>",
  "optionId":     "<optionId>"
}
```

`status: "sent"` means the decision was delivered to the in-flight read loop.
Other statuses indicate delivery failure; the per-request timeout will fail the
entry closed.

## Ephemerality Contract

- Relays MUST NOT persist kind 24200 events to any durable storage.
- Relays MUST NOT include kind 24200 events in search indexes.
- Relays MUST NOT include kind 24200 events in audit logs.
- Relays SHOULD fan out kind 24200 events only via in-memory pub/sub,
  never via a database write path.
- Clients SHOULD subscribe with `since=<now - 300s>` to recover frames from the past
  five minutes (e.g., after a brief reconnect); historical replay beyond this window
  is not supported.
- Clients SHOULD buffer received events in a bounded in-memory ring buffer.

## Authorization

**Telemetry** (agent → owner):
- `event.pubkey` MUST equal the agent pubkey.
- `p` tag MUST equal the owner pubkey.
- Relay MUST verify `is_agent_owner(agent, owner)` via authenticated ownership lookup.

**Control** (owner → agent):
- `event.pubkey` MUST equal the owner pubkey.
- `p` tag MUST equal the agent pubkey.
- Relay MUST verify `is_agent_owner(agent, owner)` where agent is resolved from the
  `agent` tag.

Both directions require relay confirmation of the agent-owner relationship via
database lookup. `#p` tag matching alone is insufficient. Unauthorized publish or
subscribe attempts MUST be rejected with `AUTH required`.

The harness additionally enforces a ±5-minute `created_at` freshness window on
incoming control frames as defense-in-depth against relay-captured replay.

## Relay Behavior

On receiving a kind 24200 event, a relay MUST:

1. Validate the event signature per NIP-01.
2. Verify authorization per the rules above.
3. Fan out to matching subscribers via in-memory pub/sub.
4. NOT invoke the normal event ingestion or persistence path.

Relays SHOULD enforce a rate limit of 100 events/second per agent pubkey.
Relays are RECOMMENDED to reject events whose `created_at` falls outside a ±5-minute
freshness window to prevent replay of captured events.

## Client Behavior

Clients subscribe with:

```json
{"kinds": [24200], "#p": ["<own_pubkey>"], "since": <now - 300>}
```

The `since` lookback of 300 seconds (5 minutes) allows recovery of recent frames
after brief reconnects without enabling unbounded historical replay.

On receiving an event, a client MUST:

1. Verify the event signature.
2. Decrypt `content` using own secret key and `event.pubkey`.
3. Parse the decrypted payload and dispatch on `kind` (telemetry) or `type` (control).
4. Ignore unknown `kind`/`type` values.

Clients SHOULD verify that the `agent` tag matches a known/trusted agent pubkey
before decrypting.

Clients SHOULD buffer events in a bounded ring buffer (RECOMMENDED maximum: 800 events).
Clients MUST NOT request historical kind 24200 events beyond the 5-minute lookback
window (no `since` further in the past, no `until`, no `ids` queries).

## Security Considerations

**Metadata leakage.** Routing tags (`p`, `agent`, `frame`, `created_at`) are
cleartext. A relay operator can observe that agent X is streaming to owner Y at what
rate. For maximum metadata privacy, implementors MAY wrap events in NIP-59 gift wrap.

**No forward secrecy.** NIP-44 does not provide forward secrecy; compromise of the
agent's private key allows decryption of any captured ciphertext.

**Replay attacks.** A captured, signed event could be replayed without a freshness
check. Relays are RECOMMENDED to enforce a `created_at` freshness window. The harness
enforces this as defense-in-depth on incoming control frames.

**Rogue relays.** The ephemerality contract is relay policy, not cryptography.
NIP-44 encryption ensures stored events remain opaque to the relay operator absent
key compromise.

**Best-effort delivery.** Control frames can be dropped during reconnect or queue
overflow. `permission_decision` frames follow the same best-effort path; the
mandatory per-request fail-closed timeout (max 300 seconds) ensures the harness never
blocks indefinitely waiting for a decision that never arrives.

**Permission nonce security.** Request nonces are single-use and generated fresh per
request. A `permission_decision` carrying a nonce that does not match an active
pending entry is silently ignored. The harness verifies that the chosen `optionId` is
present in the exact option snapshot captured at nonce generation — preventing a
replayed or modified decision from selecting an option not offered in the original
request.

**Cancel during write (poison).** If a cancel arrives while the harness is writing
an ACP permission response mid-flight, the process state is irrecoverably uncertain.
The harness surfaces a dedicated `PermissionPoisoned` error through `cancel_with_cleanup_grace`,
which causes the pool to respawn the agent process rather than return it. All other
pending permission entries for that session are drained with `cancelled` responses.

**Operational persistence vectors.** Telemetry may transiently exist in process
memory, crash dumps, and application logs. Implementations SHOULD minimize logging
of decrypted payloads and MUST NOT log them at INFO level or above.

## Relationship to Other NIPs

- **NIP-01**: Kind 24200 is in the ephemeral range (20000–29999); standard event
  structure and signature rules apply.
- **NIP-42**: Recommended for relay-side authentication gating.
- **NIP-44**: Required encryption algorithm for all `content` fields.
- **NIP-29**: An `h` tag MAY be included when the agent session is scoped to a
  NIP-29 group.
- **NIP-XX (PR #2226)**: NIP-XX defines the agent *output* plane; this NIP defines
  the *observability* plane (internal agent activity). They are complementary and
  non-overlapping.

## Examples

### 1. Telemetry Event — `acp_write` frame

**Wire event (encrypted):**

```json
{
  "id":         "a1b2c3d4...",
  "kind":       24200,
  "pubkey":     "agent_pubkey_hex",
  "created_at": 1777464041,
  "content":    "<NIP-44 v2 ciphertext>",
  "tags": [
    ["p",     "owner_pubkey_hex"],
    ["agent", "agent_pubkey_hex"],
    ["frame", "telemetry"]
  ],
  "sig": "..."
}
```

**Decrypted payload:**

```json
{
  "seq":        42,
  "timestamp":  "2026-04-29T12:00:41.500Z",
  "kind":       "acp_write",
  "agentIndex": 0,
  "channelId":  "52a85618-0f8f-4542-94ec-599e6e1c6f2e",
  "sessionId":  "a1b2c3d4",
  "turnId":     "e5f6g7h8",
  "payload": {
    "jsonrpc": "2.0",
    "method":  "tools/call",
    "params":  { "name": "shell", "arguments": { "command": "ls -la" } }
  }
}
```

---

### 2. Control Event — `cancel_turn` frame

**Wire event (encrypted):**

```json
{
  "id":         "e5f6a7b8...",
  "kind":       24200,
  "pubkey":     "owner_pubkey_hex",
  "created_at": 1777464042,
  "content":    "<NIP-44 v2 ciphertext>",
  "tags": [
    ["p",     "agent_pubkey_hex"],
    ["agent", "agent_pubkey_hex"],
    ["frame", "control"]
  ],
  "sig": "..."
}
```

**Decrypted payload:**

```json
{
  "type":      "cancel_turn",
  "channelId": "52a85618-0f8f-4542-94ec-599e6e1c6f2e"
}
```

---

### 3. Permission request (ask policy) — challenge + decision round trip

**Step 1 — agent emits `session/request_permission`; harness emits `acp_read` telemetry:**

```json
{
  "seq":        101,
  "timestamp":  "2026-08-01T10:00:00.000Z",
  "kind":       "acp_read",
  "agentIndex": 0,
  "channelId":  "52a85618-0f8f-4542-94ec-599e6e1c6f2e",
  "sessionId":  "sess-abc",
  "turnId":     "turn-xyz",
  "authorization": {
    "requestNonce": "a9f3b2c1d4e5...",
    "actionable":   true
  },
  "payload": {
    "jsonrpc": "2.0",
    "id": "req-17",
    "method": "session/request_permission",
    "params": {
      "sessionId": "sess-abc",
      "options": [
        { "optionId": "opt-allow", "kind": "allow_once", "name": "Allow once" },
        { "optionId": "opt-deny",  "kind": "reject_once", "name": "Deny" }
      ]
    }
  }
}
```

**Step 2 — desktop sends `permission_decision` control frame:**

```json
{
  "type":         "permission_decision",
  "channelId":    "52a85618-0f8f-4542-94ec-599e6e1c6f2e",
  "requestNonce": "a9f3b2c1d4e5...",
  "optionId":     "opt-allow"
}
```

**Step 3 — harness writes ACP response and emits `acp_write` telemetry:**

```json
{
  "seq":        102,
  "timestamp":  "2026-08-01T10:00:04.120Z",
  "kind":       "acp_write",
  "agentIndex": 0,
  "channelId":  "52a85618-0f8f-4542-94ec-599e6e1c6f2e",
  "sessionId":  "sess-abc",
  "turnId":     "turn-xyz",
  "authorization": {
    "requestNonce": "a9f3b2c1d4e5...",
    "actionable":   false,
    "reason":       "applied"
  },
  "payload": {
    "jsonrpc": "2.0",
    "id": "req-17",
    "result": { "outcome": { "outcome": "selected", "optionId": "opt-allow" } }
  }
}
```

Note: `actionable` is `false` on the `acp_write` telemetry frame — the decision has
been applied and the card is no longer actionable. `reason: "applied"` is the
standard terminal annotation for a successfully delivered decision. When the request
expires without a decision, the harness emits `reason: "timed_out"`. When the turn
is cancelled while the request is pending, the harness emits `reason: "cancelled"`.
If the cancel arrives mid-write (`uncertain`), no `acp_write` frame is emitted at all.

## Reference Implementation

[block/buzz PR #4938](https://github.com/block/buzz/pull/4938)
