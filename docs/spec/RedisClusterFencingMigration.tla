------------------- MODULE RedisClusterFencingMigration -------------------
(***************************************************************************)
(* Fencing-key migration for Redis cluster mode.                          *)
(*                                                                         *)
(* The relay's tunnel session directory fences mesh frames with a          *)
(* {lease, generation} key pair per session (tunnel/directory.rs). Under   *)
(* cluster mode the pair must share a hash slot, which forces a key        *)
(* RENAME. The generation key is deliberately non-expiring and is the      *)
(* fencing authority: it must never fork (two live leases for one          *)
(* session) and never go backward or repeat (a generation, once issued,    *)
(* is never issued again for that session).                                *)
(*                                                                         *)
(* This module models the staged migration:                                *)
(*   version O (0): legacy scripts — old keys only, checks old lease.      *)
(*   version A (1): union lease check; lease written to OLD key;           *)
(*                  generation = max(oldGen,newGen)+1 written to BOTH.     *)
(*   version B (2): union lease check; lease written to NEW key;           *)
(*                  generation = max(oldGen,newGen)+1 written to NEW.      *)
(*   backfill:      after full-B, fold oldGen into newGen (max-merge).     *)
(*   version C (3): new keys only (cluster-safe: no cross-slot reads).     *)
(*   enable:        cluster mode enabled; old keys become unreachable.     *)
(*                                                                         *)
(* Rolling deploys mean adjacent versions coexist; the phase variable      *)
(* enforces that the fleet spans at most versions {phase-1, phase}.        *)
(*                                                                         *)
(* One session is modeled; sessions are independent (per-session keys).    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Pods,      \* set of relay pods
          None,      \* model value: no lease owner
          MaxGen     \* finiteness bound on generation counters

ASSUME None \notin Pods

VARIABLES
  phase,       \* deployment target version, 0..3
  ver,         \* [Pods -> 0..3], each pod's deployed script version
  oldOwner,    \* lease on OLD key: owner pod or None
  oldLeaseGen, \* generation carried by the live old-key lease (0 if none)
  newOwner,    \* lease on NEW (hash-tagged) key: owner pod or None
  newLeaseGen, \* generation carried by the live new-key lease (0 if none)
  oldGen,      \* OLD non-expiring generation counter
  newGen,      \* NEW non-expiring generation counter
  backfilled,  \* one-time oldGen -> newGen max-merge has run
  clusterOn,   \* cluster mode enabled (the one-way door)
  lastIssued,  \* history: highest generation ever issued to a lease
  monoOk       \* history flag: FALSE iff an issue was <= a prior issue

vars == <<phase, ver, oldOwner, oldLeaseGen, newOwner, newLeaseGen,
          oldGen, newGen, backfilled, clusterOn, lastIssued, monoOk>>

Max(a, b) == IF a > b THEN a ELSE b

TypeOK ==
  /\ phase \in 0..3
  /\ ver \in [Pods -> 0..3]
  /\ oldOwner \in Pods \cup {None}
  /\ newOwner \in Pods \cup {None}
  /\ oldLeaseGen \in 0..MaxGen
  /\ newLeaseGen \in 0..MaxGen
  /\ oldGen \in 0..MaxGen
  /\ newGen \in 0..MaxGen
  /\ backfilled \in BOOLEAN
  /\ clusterOn \in BOOLEAN
  /\ lastIssued \in 0..MaxGen
  /\ monoOk \in BOOLEAN

Init ==
  /\ phase = 0
  /\ ver = [p \in Pods |-> 0]
  /\ oldOwner = None /\ oldLeaseGen = 0
  /\ newOwner = None /\ newLeaseGen = 0
  /\ oldGen = 0 /\ newGen = 0
  /\ backfilled = FALSE
  /\ clusterOn = FALSE
  /\ lastIssued = 0
  /\ monoOk = TRUE

(***************************************************************************)
(* Deployment machinery.                                                   *)
(***************************************************************************)

\* The fleet may only chase the current phase; a phase only advances when
\* every pod has reached it. Gate into C (phase 3): backfill has run AND no
\* live old-key lease remains (operationally: wait >= lease TTL after
\* full-B before deploying C).
AdvancePhase ==
  /\ phase < 3
  /\ \A p \in Pods : ver[p] = phase
  /\ (phase = 2) => (backfilled /\ oldOwner = None)
  /\ phase' = phase + 1
  /\ UNCHANGED <<ver, oldOwner, oldLeaseGen, newOwner, newLeaseGen,
                 oldGen, newGen, backfilled, clusterOn, lastIssued, monoOk>>

UpgradePod(p) ==
  /\ ver[p] < phase
  /\ ver' = [ver EXCEPT ![p] = phase]
  /\ UNCHANGED <<phase, oldOwner, oldLeaseGen, newOwner, newLeaseGen,
                 oldGen, newGen, backfilled, clusterOn, lastIssued, monoOk>>

\* One-time backfill after the whole fleet is on B: fold the old counter
\* into the new one. Idempotent max-merge.
Backfill ==
  /\ phase = 2
  /\ \A p \in Pods : ver[p] = 2
  /\ newGen' = Max(newGen, oldGen)
  /\ backfilled' = TRUE
  /\ UNCHANGED <<phase, ver, oldOwner, oldLeaseGen, newOwner, newLeaseGen,
                 oldGen, clusterOn, lastIssued, monoOk>>

\* The one-way door. Only after the whole fleet runs C scripts (which
\* never touch old keys, so no cross-slot access exists to break).
EnableCluster ==
  /\ ~clusterOn
  /\ phase = 3
  /\ \A p \in Pods : ver[p] = 3
  /\ clusterOn' = TRUE
  /\ UNCHANGED <<phase, ver, oldOwner, oldLeaseGen, newOwner, newLeaseGen,
                 oldGen, newGen, backfilled, lastIssued, monoOk>>

(***************************************************************************)
(* Acquire, per script version. Each is one atomic Lua script.             *)
(***************************************************************************)

RecordIssue(g) ==
  /\ lastIssued' = Max(lastIssued, g)
  /\ monoOk' = (monoOk /\ (g > lastIssued))

\* Version O (legacy, deployed today): old keys only.
AcquireO(p) ==
  /\ ver[p] = 0
  /\ oldOwner = None
  /\ oldGen + 1 <= MaxGen
  /\ oldGen' = oldGen + 1
  /\ oldOwner' = p /\ oldLeaseGen' = oldGen + 1
  /\ RecordIssue(oldGen + 1)
  /\ UNCHANGED <<phase, ver, newOwner, newLeaseGen, newGen, backfilled,
                 clusterOn>>

\* Version A: union lease check; lease still on OLD key; generation is
\* max-merged and written to BOTH counters. (The max-merge here is
\* load-bearing: without it, an A-pod acquiring after a B-pod re-issues a
\* generation B already issued — see mutation M5.)
AcquireA(p) ==
  /\ ver[p] = 1
  /\ oldOwner = None /\ newOwner = None
  /\ LET g == Max(oldGen, newGen) + 1 IN
       /\ g <= MaxGen
       /\ oldGen' = g /\ newGen' = g
       /\ oldOwner' = p /\ oldLeaseGen' = g
       /\ RecordIssue(g)
  /\ UNCHANGED <<phase, ver, newOwner, newLeaseGen, backfilled, clusterOn>>

\* Version B: union lease check; lease moves to the NEW key; generation
\* max-merged into the NEW counter.
AcquireB(p) ==
  /\ ver[p] = 2
  /\ oldOwner = None /\ newOwner = None
  /\ ~clusterOn  \* B reads old keys: cross-slot, pre-cluster only
  /\ LET g == Max(oldGen, newGen) + 1 IN
       /\ g <= MaxGen
       /\ newGen' = g
       /\ newOwner' = p /\ newLeaseGen' = g
       /\ RecordIssue(g)
  /\ UNCHANGED <<phase, ver, oldOwner, oldLeaseGen, oldGen, backfilled,
                 clusterOn>>

\* Version C: new keys only. Cluster-safe.
AcquireC(p) ==
  /\ ver[p] = 3
  /\ newOwner = None
  /\ newGen + 1 <= MaxGen
  /\ newGen' = newGen + 1
  /\ newOwner' = p /\ newLeaseGen' = newGen + 1
  /\ RecordIssue(newGen + 1)
  /\ UNCHANGED <<phase, ver, oldOwner, oldLeaseGen, oldGen, backfilled,
                 clusterOn>>

(***************************************************************************)
(* Lease loss: TTL expiry or explicit release. Generations survive.        *)
(***************************************************************************)

ExpireOld ==
  /\ oldOwner /= None
  /\ oldOwner' = None /\ oldLeaseGen' = 0
  /\ UNCHANGED <<phase, ver, newOwner, newLeaseGen, oldGen, newGen,
                 backfilled, clusterOn, lastIssued, monoOk>>

ExpireNew ==
  /\ newOwner /= None
  /\ newOwner' = None /\ newLeaseGen' = 0
  /\ UNCHANGED <<phase, ver, oldOwner, oldLeaseGen, oldGen, newGen,
                 backfilled, clusterOn, lastIssued, monoOk>>

Next ==
  \/ AdvancePhase
  \/ EnableCluster
  \/ Backfill
  \/ ExpireOld
  \/ ExpireNew
  \/ \E p \in Pods : UpgradePod(p) \/ AcquireO(p) \/ AcquireA(p)
                     \/ AcquireB(p) \/ AcquireC(p)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Safety invariants.                                                      *)
(***************************************************************************)

\* T1: fencing authority never forks — at most one live lease per session
\* across BOTH keyspaces, at every instant of the migration.
Inv_SingleAuthority == oldOwner = None \/ newOwner = None

\* T2: generations are strictly monotonic per session — no generation is
\* ever issued twice, across the old/new counter handoff.
Inv_Monotonic == monoOk

\* T3: the one-way door is only crossed with no old-keyspace authority
\* left: backfill done and no live old-key lease. (After this point C
\* scripts never read old keys, so any residual old-key state is inert.)
Inv_ClusterSafe == clusterOn => (backfilled /\ oldOwner = None)

\* Sanity: a live lease always carries the generation its counter issued.
Inv_LeaseGenGrounded ==
  /\ (oldOwner /= None) => (oldLeaseGen > 0 /\ oldLeaseGen <= oldGen)
  /\ (newOwner /= None) => (newLeaseGen > 0 /\ newLeaseGen <= newGen)

=============================================================================
