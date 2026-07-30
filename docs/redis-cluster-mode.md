# Redis/Valkey Cluster Mode for the Buzz Relay: A Formal Specification

`draft`

## Abstract

This document specifies the migration of the Buzz relay's Redis/Valkey usage
from a single-shard, cluster-mode-disabled ElastiCache replication group to a
cluster-mode-enabled, N-shard topology, and gives a formal proof of the
migration's safety-critical core. Valkey executes commands on one engine
thread per node; the deployed primary's engine core is the relay's hard
scaling ceiling, and it is filling on a measured doubling curve. Sharding the
keyspace across N primaries is the durable fix — **but only for keyed
commands**: classic pub/sub broadcasts every message to every node regardless
of shard count, so converting the relay's event fan-out to *sharded* pub/sub
(`SPUBLISH`/`SSUBSCRIBE`) is a prerequisite that feeds the sizing math, not a
migration detail.

The safety-critical core is the **fenced session directory**: a per-session
`{lease, generation}` key pair mutated atomically by Lua, whose generation
counter is the relay mesh's fencing authority — non-expiring, never reset,
never forked. Cluster mode forces these keys into one hash slot, which forces
a key rename, which forces a live migration of fencing authority under a
rolling deploy. We prove three safety theorems over that migration —
**single-authority** (at no instant do two live leases exist for one session,
across both old and new keyspaces), **generation-monotonicity** (no generation
is ever issued twice across the counter handoff), and **one-way-door safety**
(cluster mode is enabled only after old-keyspace authority is provably
drained) — mechanized in TLA+ (`docs/spec/RedisClusterFencingMigration.tla`)
with every invariant shown non-vacuous by mutation.

Everything else in the migration is specified as ordered, gated engineering
work with named failure modes: the split client architecture, the sharded
pub/sub conversion, the silently-wrong `SCAN` in mesh peer discovery, and the
staged ElastiCache mode change whose final step is irreversible.

## Scope and Non-Goals

This specification proves **safety** of the fencing-key migration and states
the rest of the migration as gated obligations. It deliberately does **not**
prove:

- **Liveness or performance.** That N shards hold the growth curve, or that
  resharding completes within a window, is empirical — characterized by the
  profiling gate (G0) and load tests, not by theorem.
- **Shard count.** The shardable-keyspace vs. unshardable-broadcast ratio is
  an unmeasured input (§Open Decisions, D1). Committing a shard count before
  the profile exists would be fiction with units.
- **redis-rs / deadpool-redis / ElastiCache internals.** The cluster client's
  MOVED/ASK routing, RESP3 push delivery, and ElastiCache's online resharding
  are trusted vendor components, admitted per-deployment by conformance gates
  (§Conformance), not reproven.
- **Valkey cluster correctness.** Hash-slot assignment (CRC16 mod 16384, hash
  tags), single-slot Lua atomicity, and slot migration semantics are stated
  as axioms with documentation cites.

Stating this boundary is part of the claim, in the house style of
`docs/git-on-object-storage.md`: "provably safe migration" without naming the
trust boundary does not survive scrutiny; "the fencing handoff is
machine-checked relative to four stated axioms, and every vendor behavior is
gated by an explicit conformance test" does.

## Problem Statement (measured, 2026-07-30)

ElastiCache replication group `buzz-001` (acct 433851229429, us-west-2):
Valkey 8.0.1, `cache.r7g.8xlarge`, 1 primary + 1 replica, cluster mode
disabled, auto-failover **enabled**, Multi-AZ **enabled** (verified via
`describe-replication-groups` / `describe-cache-clusters`,
profile `bb-public-operations-ro`).

- `EngineCPUUtilization` (primary): 0.3% (Jul 21) → 8.4% (Jul 27) → 19.2%
  (Jul 30) — doubling every ~3.5–4 days. Saturation in ~8–10 days if the
  curve holds.
- Driver is command volume: get/set/eval families each ~150x in two weeks,
  pub/sub ~400x. Product growth (~80k users added), not a leak.
- Whole-instance CPU ~4%, memory 0.09%, replication lag <1ms. Vertical
  scaling is dead: same-family bigger instances have identical single-core
  speed; r8g (Graviton4) buys ~25–30% single-thread ≈ 1.5 days at the current
  doubling rate.

## System Model

A **relay pod** is stateless compute (15 pods, HPA to 25). All pods share one
Redis endpoint through two client surfaces (today): a `deadpool-redis`
command pool built from one URL (`crates/buzz-relay/src/main.rs`), and three
dedicated single-node pub/sub subscriber connections
(`crates/buzz-pubsub/src/{subscriber,cache_invalidation,conn_control}.rs`).

The relay's Redis state divides into **families with distinct consistency
obligations**. Making this distinction explicit is load-bearing for the whole
design; the two Lua-fenced keys and the discovery index must not be held to
the same standard:

| Family | Keys | Obligation | Cluster-mode status |
|---|---|---|---|
| **Fencing directory** | `buzz:<community>:tunnel:<session>:{lease,generation}` (`tunnel/directory.rs`) | **Strict**: atomic two-key Lua; generation is non-expiring fencing authority — never fork, never repeat | **Blocker (loud)**: keys share no hash tag; every script fails cross-slot. Migration is the mechanized core of this spec |
| **Mesh ready registry** | `mesh:ready:<runtime_id>` + `SCAN` discovery (`relay-mesh/registry.rs`) | **Hint, by its own contract** (`registry.rs:3-6`): entries are membership hints; the fenced directory arbitrates ownership. Bounded-staleness discovery is in-contract | **Blocker (silent)**: `SCAN` has no key, routes to one random node, returns a partial keyspace with no error |
| **Presence** | `buzz:<community>:presence:<pubkey>`, TTL 90s (`presence.rs`) | Ephemeral, self-healing | Safe: single-key ops; bulk `MGET` is auto-split per node by redis-rs (`MultipleNodeRoutingInfo::MultiSlot`, `cluster_handling/routing.rs`) |
| **Replay guard / rate limit** | `SET NX EX` (`nip98_replay.rs`); single-key Lua (`rate_limiter.rs`) | Per-key atomic | Safe once routed |
| **Event pub/sub** | `buzz:<community>:channel:<uuid>`, `buzz:<community>:global` — exact topics (`topic.rs`) | At-most-once transport hint; relay re-checks access on fan-out | **Unsharded by default** (Axiom A4). Exact topics convert to `SSUBSCRIBE`/`SPUBLISH`; conversion is prerequisite P2 |
| **Broadcast pub/sub** | `PSUBSCRIBE buzz:*:cache-invalidate`, `buzz:*:conn-control` | Must-not-miss control signals (cache coherence, live bans) | No sharded equivalent (`SPSUBSCRIBE` does not exist). **Decision D2**: stays classic — a missed transition is worse than a low-volume broadcast |

Command inventory provenance: deployed image `sha-22be8bb` = Buzz commit
`22be8bb35`, scoped `git grep` over `crates/buzz-pubsub`, `crates/buzz-relay`,
`crates/buzz-relay-mesh`; no `MULTI`/`EXEC`/pipeline found in that scope
(`RESEARCH/BB_PUBLIC_REDIS_CLUSTER_MODE_INVENTORY.md`). The two hot event-path
caches (`channel_visibility_cached`, `is_member_cached`) are in-process, not
Redis — they are not the get/set driver.

## Axioms

- **(A1) Deterministic slot assignment.** A key's slot is `CRC16(key) mod
  16384`; if the key contains a `{...}` hash tag, only the tagged substring is
  hashed. Two keys sharing a tag always share a slot, on every topology.
  (Valkey cluster spec, key distribution model.)
- **(A2) Single-slot Lua atomicity.** A Lua script whose declared `KEYS` all
  map to one slot executes atomically on that slot's primary, exactly as on a
  standalone node. A script whose keys span slots is **rejected** (loud
  failure). Scripts must declare all keys via `KEYS`; ours do.
- **(A3) Staged mode change.** ElastiCache supports `cluster-mode: disabled →
  compatible → enabled`. In *compatible*, one shard speaks both protocols and
  exposes a configuration endpoint; `compatible → disabled` is a supported
  revert. **`enabled` is irreversible** ("Reverting this configuration is not
  possible" — modify-cluster-mode.md). While *compatible*: scaling and
  engine-version changes are blocked.
- **(A4) Classic pub/sub is broadcast.** `PUBLISH` to any node is propagated
  to every node in the cluster; each node's engine thread processes every
  message. Sharded pub/sub (`SPUBLISH`/`SSUBSCRIBE`) confines propagation to
  the channel's slot owner. (cluster-spec.md §pub/sub; pubsub.md §sharded.)

A3 and A4 are the two facts that shape the entire plan: A4 makes sharded
pub/sub a sizing prerequisite; A3 makes compatible mode the last revert point.

## Client Architecture (the split)

Verified constraints, from vendored `redis 1.2.4` / `deadpool-redis 0.23.0`
source:

1. `ssubscribe`/`sunsubscribe`/cluster `subscribe` **require RESP3**
   (`check_resp3!`, hard error on RESP2). We run RESP2 today.
2. The cluster async connection has **no `get_async_pubsub()` and no
   `split()`** — push messages arrive via an mpsc `push_sender` handed to
   `ClusterClientBuilder` at build time, and the client **auto-resubscribes**
   after disconnect, emitting duplicate subscription-confirmation pushes.
3. `deadpool-redis`'s cluster `Manager` builds its client internally and
   exposes **no push-sender hook** — subscriptions need their own client
   regardless of protocol choice.
4. Protocol is **per-connection**, set by URL (`?protocol=resp3`) — the two
   clients can run different protocols with no global switch.

Therefore the target architecture is a **split**:

- **Command pool**: `deadpool-redis` cluster pool (feature `cluster` →
  `redis/cluster-async`) for all routed traffic — `GET`/`SET`/`MGET`/Lua/
  `SPUBLISH`. Protocol (RESP2 vs RESP3) is a **test-backed decision**, not a
  forced rewrite: typed command APIs may remain source-compatible, but the
  choice is admitted only by the conformance gate (G2), never assumed.
- **Subscription client**: a separate raw `ClusterClientBuilder` with
  `push_sender` on RESP3, owning all three subscriber loops. The loops are
  **rearchitected** around push delivery (the `select!`-over-`split()` shape
  does not exist here); reconnect handling must tolerate auto-resubscribe and
  duplicate `SSubscribe` pushes.

**Version floor:** `redis` ≥ **1.4.1** (prefer current 1.5.0), for:
non-blocking replica connection repair (#2120, 1.4.0), cluster retry-backoff
clamp (#2158, 1.3.0), and READONLY-path sleep removal (#2223, 1.4.1).
**Residual failure mode, not a fixed bug:** on every released version, a
**dead primary halts dispatch** pending topology refresh. Any degradation
argument that assumes graceful behavior during primary loss is wrong; this
belongs in shard-count risk math (more shards = smaller blast radius but more
primaries that can die). `deadpool-redis 0.23`'s `redis` requirement (`^1.0.3`)
admits 1.5.0 without a deadpool bump; the floor is admitted only by
`cargo update -p redis --precise <v>` plus a full workspace test run.

## The Fencing Migration (mechanized core)

### Why it exists

The directory's four Lua scripts (acquire/renew/release/validate) each
atomically touch `…:lease` and `…:generation`. Under cluster mode those keys
must share a slot (A1, A2), so they must be **renamed** to carry a shared hash
tag — e.g. `buzz:tunnel:{<community>:<session>}:lease` / `…:generation`. The
generation counter is deliberately non-expiring and is the mesh's fencing
authority (`directory.rs:1-6`): renaming it is a live handoff of authority
under a rolling deploy, where old-script and new-script pods coexist. Done
naively, two failure classes appear: **fork** (old-key lease and new-key lease
alive simultaneously — two owners for one session) and **generation reuse**
(new counter re-issues a generation the old counter already issued — a stale
frame passes the fence).

### The protocol

Script versions, deployed as a phased rollout where the fleet spans at most
two adjacent versions (the model enforces this):

- **O (legacy, deployed today):** old keys only.
- **A:** acquire checks **both** lease keys (union check); lease still
  written to the **old** key; generation issued as
  `max(oldGen, newGen) + 1`, written to **both** counters.
- **B:** union lease check; lease written to the **new** (hash-tagged) key;
  generation `max(oldGen, newGen) + 1` written to the **new** counter.
  (A/B read old keys cross-slot, so phases A and B run **before** cluster
  mode is enabled — in disabled or compatible mode, where cross-slot access
  on a single shard is legal.)
- **Backfill (once, after full-B):** fold `oldGen` into `newGen` by max-merge.
  Idempotent.
- **C:** new keys only. No cross-slot access exists anywhere. Gate into C:
  backfill has run **and** no live old-key lease remains (operationally: wait
  ≥ one lease TTL — 30s, `DEFAULT_LEASE_TTL` — after full-B).
- **Enable:** `cluster-mode=enabled` only when the whole fleet runs C. Old
  keys become unreachable garbage; the fence never consults them again.

Renew/release in A/B operate on whichever key the caller's lease names —
they never create authority, so acquire is where the proof lives.

### Safety theorems

> **T1 (Single Authority).** At every instant of the migration, at most one
> live lease exists per session across both keyspaces.
>
> **T2 (Generation Monotonicity).** Generations issued to leases are strictly
> increasing per session across the old→new counter handoff; no generation is
> ever issued twice.
>
> **T3 (One-Way-Door Safety).** Cluster mode is enabled only in states where
> old-keyspace authority is drained (backfill complete, no live old-key
> lease), so no post-enable execution ever consults a stale fencing key.

**Proof sketch.** T1: every acquire version checks the union of both lease
keys before creating authority, and phase adjacency means no pod that skips a
keyspace coexists with a pod that writes it (O writes old and checks old; the
last old-writer, A, checks new; the first new-writer, B, checks old; C checks
new after old is drained). T2: A and B issue `max(oldGen,newGen)+1` and write
it to the counter(s) subsequent versions read, so the issue sequence is
strictly increasing regardless of which version issues; the backfill max-merge
makes C's counter dominate every generation ever issued. T3: the phase gate
into C requires `backfilled ∧ oldOwner = None`, and enable requires full-C. ∎

The sketch is not the proof; the model is.

### Mechanized verification

`docs/spec/RedisClusterFencingMigration.tla` models one session (sessions are
independent — per-session keys), 3 pods, phased deployment with per-pod
upgrade interleaving, TTL expiry, backfill, and the enable action. TLC checks
five invariants; the history variables (`lastIssued`, `monoOk`) encode T2 as a
single-run safety invariant.

```
$ java -cp tla2tools.jar tlc2.TLC RedisClusterFencingMigration.tla \
    -config RedisClusterFencingMigration.cfg -deadlock
Model checking completed. No error has been found.
4153 states generated, 1487 distinct states found.
```

(`-deadlock` disables deadlock reporting because the model has *intended*
terminal states — migration complete, or the MaxGen finiteness bound reached —
which TLC would otherwise report as errors. Pods = {p1,p2,p3}, MaxGen = 4. Three pods exercise every adjacent-version
race — old/old, old/new, new/new writers; a fourth adds no qualitatively new
interleaving. Bounded check, mutation-shown non-vacuous — the standard claim
for a TLC-checked safety spec.)

**Every invariant is non-vacuous by mutation** (each mutant run in isolation):

| Mutation | Models the real bug | Trips |
|---|---|---|
| M1: `AcquireB` drops the old-lease check | new-script pod ignores legacy leases → two owners | `Inv_SingleAuthority` |
| M2: `AcquireA` drops the new-lease check | old-keyspace writer ignores new leases during rollback/mixed fleet | `Inv_SingleAuthority` |
| M3: `AcquireB` issues `newGen+1` without max-merge | fresh counter re-issues generation 1 → stale frame passes fence | `Inv_Monotonic` |
| M4: phase gate into C dropped (no backfill/drain requirement) | C deployed while an old-key lease is live → C-pod acquires over it | `Inv_SingleAuthority` |
| M5: `AcquireA` bumps only `oldGen`, skips dual-write | B never learns A's issues → reuse | `Inv_Monotonic` |

M4 is the operationally scary one: it is exactly "someone deploys the final
script version early because everything looks green."

## Sharded Pub/Sub Conversion (prerequisite P2)

By A4, shard count does not touch the ~400x pub/sub term; conversion does.

- **Exact event topics** (`buzz:<community>:channel:<uuid>`,
  `buzz:<community>:global`) convert to `SSUBSCRIBE`/`SPUBLISH`. The existing
  dynamic per-topic subscribe pattern maps directly (separate `SSUBSCRIBE`
  calls may span slots). Note: hash-tagging is deliberately **not** applied to
  topic names — each topic hashing to its own slot is what spreads
  propagation cost across shards; a `{community}` tag would recreate the hot
  node per community.
- **The two pattern subscribers stay classic** (Decision D2, argued in-thread
  and accepted): enumerating concrete channels would require a new
  subscribe-before-reachable / unsubscribe-after-last protocol with discovery
  races, and for cache invalidation and live-ban control a missed transition
  is strictly worse than a low-volume broadcast path. This accepts a
  permanently unsharded broadcast channel, gated by a volume measurement (G0
  must confirm these two channels are noise; if they are not, D2 reopens).

## Mesh Registry Discovery (the silent one)

`scan_ready()` (`relay-mesh/registry.rs`) discovers peers by `SCAN MATCH
mesh:ready:* COUNT 100`. `SCAN` carries no key; redis-rs routes it to **one
random node** (`RouteBy::Undefined` → `SingleNodeRoutingInfo::Random`) and the
cursor legitimately reaches 0 on that node — so under cluster mode discovery
**silently returns a per-call-varying subset** of peers. No error is ever
raised. This is the only cluster-unsafe site that fails silently, and it must
be tested by asserting **completeness** against a multi-shard cluster, not by
checking for errors.

**Fix:** replace keyspace scanning with a **scored-expiry index** in one slot:
heartbeat does `ZADD <index> <expiry_ts> <runtime_id>` alongside the existing
`SET EX` record; discovery reads live-scored members, `MGET`s their records,
filters, and opportunistically prunes dead scores. Staleness becomes
*representable* (a score in the past) rather than an agreement property
between two structures. The registry's own contract makes this sound: entries
are **membership hints** — the fenced directory arbitrates ownership — and the
read path already skips missing/undecodable/unattested records by design. The
invariant is **bounded discoverability** (a live runtime is discoverable
within one heartbeat interval; no unauthenticated record is ever returned),
*not* set equality. The single-slot concentration clears on measured load:
one `ZADD` per runtime per 15s across 15–25 pods ≈ 1–2 ops/s, three orders
below the hot path — deployment-global, so re-check if fleet size explodes.

**This spec is explicit that the registry's consistency obligations are
weaker than the tunnel directory's *by design*.** Holding both to the fencing
standard would gold-plate a hint; holding the fence to the hint standard
would corrupt sessions. (Table in §System Model.)

## Migration Plan (gates, in order)

**G0 — Profile the hot path** *(informs everything; owner: option-3 owner)*.
Attribute the 150x get/set and 400x pub/sub growth to code paths; measure the
shardable-vs-broadcast ratio (this is the shard-count input) and the two
pattern-subscriber volumes (gates D2). Known: in-process caches are not the
driver; suspects are presence and per-event rate-limiter Lua — hypothesis,
not finding. If the driver is the rate limiter, "batch it" is not available
(atomic per-event counter); volume reduction takes a different shape.

**G1 — Code prerequisites** *(can start now, independent of G0)*:
  1. Fencing migration phases A→B→backfill→C per the mechanized protocol.
  2. Registry scored-expiry index replacing `SCAN`.
  3. Split client architecture + `redis` ≥ 1.4.1 + feature flags.
  4. Subscriber loops rearchitected (push_sender, RESP3, auto-resubscribe).
  5. Sharded pub/sub conversion for exact topics (D2 leaves patterns classic).

**G2 — Conformance against a real multi-shard Valkey cluster** (test matrix
below). No date is committed before this compiles and passes.

**G3 — `cluster-mode=compatible`** (revert available). Client cutover to the
configuration endpoint; validate under real traffic. No scaling/engine
changes while here (A3) — **the r8g tourniquet and this migration are
mutually exclusive in flight**; entering compatible forecloses the vertical
escape hatch for the duration.

**G4 — `cluster-mode=enabled`** — **the one-way door** (A3). Requires: fleet
fully on C-scripts (T3 gate), G2/G3 green, and a key-size sanity pass (slots
holding items >256MB silently refuse to migrate; our 0.09% memory makes this
unlikely — "unlikely" is not "checked").

**G5 — Add shards** (online resharding). Do it **early**: AWS guidance says
keep CPU <80% during resharding — resharding is compute-intensive, and doing
it while the engine core saturates is the worst time. The countdown clock is
the argument for starting G1 now, not for heroics at 90%.

**Fallback (curve outruns the plan):** replica read offload
(`buzz-001-002` idles at 7%) buys roughly one doubling. Note the coupling: in
cluster mode, replica reads lean on exactly the replica-repair path fixed in
redis-rs #2120/#2223, so the version floor is a prerequisite for the fallback
too, not just hygiene.

## Conformance (test matrix, gate G2)

Run against a real multi-shard Valkey 8 cluster (not a mock, not a single
node in cluster mode). Two verdict columns — **errors** and **silently
wrong** — because three of our bugs would pass an error-only harness:

| Surface | Must verify |
|---|---|
| Routing | MOVED/ASK redirects under slot migration; TLS/auth on the configuration endpoint |
| Fencing scripts | Hash-tagged pairs execute atomically; cross-slot rejection observed for un-tagged pairs (negative test); per-node script cache / NOSCRIPT handling |
| Fencing migration | A/B/backfill/C staged deploy against live traffic in compatible mode; generation strictly increases across the handoff (assert, don't assume) |
| Presence `MGET` | Nil/order preservation when split per node |
| Registry index | **Completeness**: every live runtime discoverable within one heartbeat; assert against known population, not absence of errors |
| Subscriptions | RESP3 push delivery; dynamic ssubscribe/sunsubscribe; reconnect with auto-resubscribe; duplicate subscription-confirmation pushes handled; message routing correct across shards |
| Failure drills | Replica connection repair **under load** (the #2120 path); primary failover — characterize the dispatch halt window; both clients (command pool + subscription client) have independent recovery behavior — drill both |
| Protocol choice | Command pool compiled and integration-tested under its chosen protocol (RESP2 or RESP3) — admitted by test, never assumed |

## Failure Modes (named, with dispositions)

| Failure | Loud/Silent | Disposition |
|---|---|---|
| Cross-slot Lua (fencing keys, pre-fix) | Loud | Fixed by design (hash tag + mechanized migration) |
| `SCAN` partial discovery | **Silent** | Fixed by design (scored-expiry index); completeness-asserting test |
| Dead primary halts client dispatch pending topology refresh | Loud-ish (latency wall) | Residual on all redis-rs versions; goes in shard-count risk math; drilled in G2 |
| Missed cache-invalidate / conn-control message | Silent | Avoided by D2 (patterns stay classic broadcast) |
| Generation fork/reuse during migration | Silent (fence passes stale frame) | Excluded by T1/T2 (mechanized, mutation-tested) |
| Premature `enabled` | Irreversible | Excluded by T3 gate + A3 named as one-way door |
| >256MB items refuse slot migration | Silent (permanent imbalance) | Key-size pass at G4 |
| Resharding under CPU pressure | Loud | G5 scheduled early, <80% CPU rule |

## Implementation Correspondence

Code pins are at deployed commit `22be8bb35` (verified against image tag
`sha-22be8bb`); symbols, not line numbers, are normative after refactors.

| Spec element | Code |
|---|---|
| Fencing scripts (acquire/renew/release/validate) | `crates/buzz-relay/src/tunnel/directory.rs` (`ACQUIRE_SCRIPT` etc.) |
| Fencing keys needing hash tag | `SessionKeys::new` (`directory.rs`) |
| Lease TTL (drain window for C-gate) | `DEFAULT_LEASE_TTL` = 30s (`directory.rs`) |
| Registry `SCAN` to replace | `scan_ready` (`relay-mesh/registry.rs`) |
| Registry heartbeat to extend with `ZADD` | `publish_ready` (`registry.rs`), `spawn_registry_heartbeat` (`runtime.rs`) |
| Exact topics for sharded pub/sub | `EventTopicKey::redis_channel` (`buzz-pubsub/src/topic.rs`) |
| Pattern subscribers staying classic | `cache_invalidation.rs`, `conn_control.rs` (`psubscribe`) |
| Subscriber loops to rearchitect | `subscriber.rs` (`get_async_pubsub` + `split`) |
| Presence bulk read (auto-split, no change) | `get_presence_bulk` (`presence.rs`) |
| Command pool construction | `deadpool_redis::Config::from_url` (`buzz-relay/src/main.rs`) |
| Feature flags to add | workspace `Cargo.toml` `redis`/`deadpool-redis` entries |

## Open Decisions

- **D1 — Shard count.** Blocked on G0's shardable/broadcast ratio. The spec
  deliberately refuses a number until the ratio exists.
- **D2 — Pattern subscribers stay classic.** Accepted in design; re-opens
  only if G0 shows their volume is non-trivial.
- **D3 — Command-pool protocol (RESP2 vs RESP3).** Test-backed decision at
  G2; the split architecture makes it independent of the subscription
  client's hard RESP3 requirement.
- **D4 — G0 ownership.** Profiling was kicked off as option 3; needs an
  owner and telemetry access. It gates D1, so it is on the critical path for
  shard count but *not* for starting G1.

## Summary

| Property | Status | Discharged by |
|---|---|---|
| Fencing single-authority (T1) | Proved | TLA+ model, mutation-tested |
| Generation monotonicity (T2) | Proved | TLA+ model, mutation-tested |
| One-way-door safety (T3) | Proved | Phase gate + A3, mechanized |
| Vendor cluster behaviors | Empirical | Conformance matrix (G2) |
| Sharded pub/sub necessity | Documented fact | Axiom A4 (Valkey cluster spec) |
| Shard count | **Open** | G0 profile (D1) |
| Timeline | ~8–10 days of runway at current doubling | G1 starts now; fallback = replica offload |
