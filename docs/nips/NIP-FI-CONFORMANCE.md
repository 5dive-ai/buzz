# NIP-FI conformance evidence

This document turns the stable trace identifiers in the normative [NIP-FI specification](NIP-FI.md#stable-conformance-labels) and [formal model](NIP-FI-MODEL.md#stable-conformance-traces) into a behavioral evidence contract. The specification and model remain normative.

A document, source scan, compiled symbol, configuration key, or passing prose review does not prove conformance. A claim is valid only when executable adapters exercise the behavior at the exact implementation revision and preserve the evidence required below.

## Claim unit

A conformance claim names one immutable tuple:

```text
(implementation revision,
 adapter revision,
 build artifact digest,
 deployment revision,
 domain-policy digest,
 advertised transport profiles,
 enrollment mode,
 delegation support)
```

Changing any element creates a new claim. Results from another tuple cannot be carried forward without rerunning the affected traces. A report includes all 24 `FI-TRACE-*` identifiers exactly once.

The later implementation stack owns the executable adapters and exact commands. This documentation revision supplies no runtime adapter and closes no behavioral gate.

## Evidence rules

Each passing trace records:

- the exact claim tuple;
- a stable behavioral test ID and adapter entry point;
- the command, start and end times, exit status, and random seed when used;
- synthetic input or a privacy-safe digest of it;
- relevant before-and-after state, wire results, and lease or lifecycle versions;
- the expected oracle and observed result;
- artifact locations and SHA-256 digests; and
- cleanup status for synthetic identities, keys, and domains.

Stateful tests use an isolated database or namespace. They inspect committed state after the operation instead of inferring state from a response. Concurrency tests record every contender and the single serialized outcome. Time-boundary tests use a controlled clock. Privacy tests inspect protocol output and the configured log, metric, and trace sinks.

When an adapter evaluates denial timing, it freezes the sampling method, production-equivalent environment, warm-up, sample count, statistic, noise treatment, and acceptance threshold before execution. The report retains those values and the raw privacy-safe measurements. An undefined or post-selected threshold cannot pass a trace.

The following do not satisfy a trace:

- searching source, documentation, schemas, or binaries for a token;
- asserting that a route calls a named function;
- recording only a unit-test name without its execution result;
- using a mock to prove deployed network isolation;
- citing a pull request check from another revision; or
- marking a required trace as passed because the feature is configured.

## Trace matrix

| Trace ID | Required behavioral oracle | Minimum evidence | Normative references |
|---|---|---|---|
| `FI-TRACE-PROXY-SPOOF` | Direct ingress, missing or repeated provenance, mixed profiles, client-supplied provenance, malformed canonical encoding, and every clock or size violation deny before authority. No fallback to `client-attached` occurs. | Deployed negatives from inside and outside the edge; missing/repeated/comma/extra components; non-canonical base64url; nonce lengths 15, 16, configured maximum, and maximum plus one; MAC lengths 31, 32, and 33; field maximum and maximum plus one; future-skew equality and excess; age-bound just-before and equality; overflow cases; listener topology; responses; and no-mutation state diffs. | `FI-INV-04`, `FI-INV-05`, `FI-INV-14` |
| `FI-TRACE-PROXY-REPLAY` | Final admissions using one live HMAC nonce commit at most once, including when the nonce is re-signed by another concurrently active secret. Preparation consumes nothing. | Parallel same-secret and cross-secret overlap transcripts, domain/profile replay namespace, replay-store before/after state, committed receipt count, matched secret version as private audit metadata only, and retention deadline. | `FI-INV-08`, `FI-INV-09`, `FI-INV-14` |
| `FI-TRACE-PROXY-CROSS-REQUEST` | Changing assertion, method, authority, path/query, or body denies under the original MAC. | One valid baseline plus one mutation for every bound field, exact canonical byte fixtures, and wire results. | `FI-INV-04`, `FI-INV-05` |
| `FI-TRACE-AUTHORITY-UNIFORM` | Every protected ingress uses one current domain policy and final-admission authority. Uncovered, competing, and different-lineage paths fail closed. | Executed route inventory covering WebSocket and every protected HTTP class, policy identity observed per route, negative unknown-route case, and startup result for incompatible policy lineage. | `FI-INV-15` |
| `FI-TRACE-VERIFIER-PARITY` | After valid profile-specific transport handling, the same assertion, policy, time, and JWKS snapshot produce the same normalized assertion-verifier decision on every transport. WebSocket and HTTP accept the assertion only as exactly one `Nostr-Federated-Identity: Bearer <JWT>` field. | Shared assertion corpus through every adapter with byte-for-byte normalized verifier decisions; valid single-field cases; and transport rejection of `Authorization` bearer assertions, missing/repeated/comma-combined fields, provenance on `client-attached`, and mixed profiles on both WebSocket and HTTP. | `FI-INV-06`, `FI-INV-16` |
| `FI-TRACE-DOMAIN-SPOOF` | Client domain, host, or forwarded authority cannot replace the server-selected domain. | Multi-domain requests over each ingress, trusted-route observation, state diff proving no cross-domain mutation, and redacted denial. | `FI-INV-04`, `FI-INV-14` |
| `FI-TRACE-ASSERTION-KEY-MISMATCH` | An asserted key different from the proven key denies before mutation. | Valid assertion and proof fixture with unequal keys, decision capture, and complete authority-state diff. | `FI-INV-05`, `FI-INV-08` |
| `FI-TRACE-BINDING-CONFLICT` | A conflict on either side of the active partial bijection denies without replacement or provenance change. | Identity-side and key-side conflict cases, before/after binding rows, lifecycle selectors, and receipts. | `FI-INV-01`, `FI-INV-02`, `FI-INV-09` |
| `FI-TRACE-TOMBSTONE-REPLAY` | Fresh evidence cannot cross a retired pair, disabled identity, revoked key, or pending replacement. | Four selector cases plus selector-conflict fixtures, fresh evidence, redacted responses, and unchanged state. | `FI-INV-03`, `FI-INV-10`, `FI-INV-14` |
| `FI-TRACE-ASSERTION-REFRESH` | A fresh assertion authorizes the same eligible durable binding after the enrollment assertion expires. | Controlled clock before and after original expiry, unchanged binding version and provenance, new bounded lease, and original assertion rejection. | `FI-INV-02`, `FI-INV-11` |
| `FI-TRACE-ADMIN-EXPIRY` | Before administrative expiry may allow; equality and after deny. Time alone creates no tombstone or free coordinate. | Controlled-clock before/equal/after cases, binding and selector state, lease deadline, and explicit privileged restoration case. | `FI-INV-02`, `FI-INV-10`, `FI-INV-11` |
| `FI-TRACE-JWKS-ADD` | A new generation that retains the signing key revalidates prepared evidence and may authorize the unchanged binding. | Two key snapshots, generation witnesses, retained signing-key identity, exact assertion revalidation, and final result. | `FI-INV-06`, `FI-INV-07` |
| `FI-TRACE-JWKS-REMOVE` | Removing the signing key denies prepared evidence and active direct leases. Hard snapshot expiry also denies when current state is unreadable. | Prepared and leased cases across removal, hard-deadline boundary, refresh outage, lease closure, and unchanged binding. | `FI-INV-07`, `FI-INV-11`, `FI-INV-14` |
| `FI-TRACE-PREPARED-STALE` | A changed request or applicable decision witness cannot authorize from stale preparation. Equivalent concurrent enrollment may recompute as existing. | Mutations for request, binding, lifecycle, mode, policy, resource, delegation, relationship, replay, and invalidation witnesses at final admission; final state and recomputation evidence. | `FI-INV-08`, `FI-INV-09`, `FI-INV-14` |
| `FI-TRACE-FINAL-DENIAL-NO-MUTATION` | Preparation, local-policy denial, and final-admission denial create no authority, audit observation, replay claim, receipt, lease, or application mutation. | Complete before/after snapshots for each denial layer, including application storage and replay/audit stores. | `FI-INV-08`, `FI-INV-09` |
| `FI-TRACE-CONCURRENT-ENROLLMENT` | Identical first uses converge on one binding version. Conflicting first uses commit at most one winner. | Barrier-synchronized identical and conflicting races, all results, proof of the serialized single-winner outcome, history count, and final binding. | `FI-INV-01`, `FI-INV-09` |
| `FI-TRACE-TOFU-THEFT` | Stolen-assertion first use denies in attested and provisioned modes. Only explicitly configured risk-labelled TOFU may create the attacker's proven key. | Same synthetic theft fixture under all three modes, discovery/config witness, provenance result, and no-mutation denials. | `FI-INV-05`, `FI-INV-10` |
| `FI-TRACE-DELEGATE-OWNER-ROTATED` | Rotation, retirement, disablement, key revocation, owner-binding version change, or relationship revision makes old delegation non-current. No authority transfers to a replacement key. | Delegated allow baseline; each dependency mutation between preparation and final admission and during lease reuse; exact owner and relationship versions; replacement-key non-inheritance; denial; and bounded closure time. | `FI-INV-10`, `FI-INV-12` |
| `FI-TRACE-DELEGATION-EXPIRED` | Missing finite configuration, delegation-expiry equality, owner administrative-expiry equality, and use after either bound deny. | Controlled-clock just-before/equal/after cases for both bounds, configuration omission case, delegate proof, exact owner version, and lease deadline. | `FI-INV-11`, `FI-INV-12`, `FI-INV-14` |
| `FI-TRACE-DENIAL-ORACLE` | Unknown identity, conflicts, tombstones, enrollment posture, and private-policy denials are not distinguishable on the public wire. | Public response corpus normalized by transport, status/prefix comparison, predeclared timing method and threshold with raw measurements, and private-detail scan. | `FI-INV-13` |
| `FI-TRACE-DEPENDENCY-FAIL-CLOSED` | Unreadable verifier, JWKS, binding, lifecycle, replay, policy, receipt, audit, or invalidation state never allows. | One injected outage per dependency at preparation, final admission, and lease reuse where applicable; results and state diffs. | `FI-INV-14` |
| `FI-TRACE-MULTI-KEY-SESSION` | A lease for one authenticated key cannot authorize another key on the same connection. | One connection with two keys, per-key operations, lease lookup evidence, and wire results before and after invalidation. | `FI-INV-05`, `FI-INV-11` |
| `FI-TRACE-CROSS-DOMAIN-COLLISION` | Equal subjects across issuers and equal pairs across domains remain distinct and inherit no authority. | Two issuers and two domains with controlled collisions, four state snapshots, and cross-use denials. | `FI-INV-01`, `FI-INV-04` |
| `FI-TRACE-PRIVACY-NONPUBLIC` | Assertions and private identity material never enter protocol output, public history, discovery, logs, metrics, or traces. | Seeded canary claims, successful and denied flows, scans of every configured sink, and access-control evidence for retained private state. | `FI-INV-13`; [NIP-FI privacy](NIP-FI.md#privacy); [model privacy](NIP-FI-MODEL.md#denial-and-privacy-model) |

## Applicability

Every report contains every trace ID. `pass` and `not-applicable` are the only claimable statuses. A blank, skipped, expected failure, or `not-run` result cannot support a claim.

`not-applicable` needs a machine-readable reason and behavioral proof that the optional surface is absent:

- proxy traces may be not applicable only when `trusted-proxy-hmac-v1` is neither accepted nor advertised and executable absence cases show rejection;
- TOFU may be not applicable only when risk-labelled TOFU is neither configurable nor advertised and executable absence cases show rejection;
- delegation traces may be not applicable only when delegation is disabled, omitted from discovery, and denied on every ingress; and
- every other trace is required for an enforcing deployment.

An implementation that supports an optional surface must run its traces even when one deployed domain does not activate that surface.

## Adapter contract

The implementation stack must supply an adapter manifest at its exact head. The manifest maps each applicable trace to executable test IDs and commands. It also identifies required services, fixtures, fault injection, and deployed-boundary steps.

Adapters must drive public or production-equivalent entry points. Storage helpers may inspect state and inject a dependency outage, but they cannot replace the operation under test. A route test that calls an internal authorization function without traversing the protected ingress does not satisfy route coverage.

The adapter exits nonzero when:

- a trace is absent or duplicated;
- the implementation, adapter, artifact, deployment, or policy digest differs from the claim tuple;
- a required result is not `pass`;
- a `not-applicable` result lacks absence evidence;
- an evidence artifact is missing or its digest differs; or
- cleanup or privacy inspection is incomplete.

The example [conformance report](../examples/nip-fi-conformance-report.json.example) contains every stable trace with `not-run` status. It is a shape example, not a conformance claim.

## Release gate

Before NIP-FI discovery or enforcement is activated, reviewers verify:

1. The implementation stack supplies exact-head behavioral adapters for every applicable trace.
2. One immutable claim tuple passes the complete matrix.
3. The protected-ingress inventory has no uncovered or competing authority.
4. Trusted-proxy deployments include live bypass, mixed-profile, header-injection, replay, and cross-request evidence.
5. Restore, rollback, lifecycle, and dependency-outage exercises have completed against production-equivalent storage.
6. Public and operational sinks pass the privacy canary inspection.

Documentation review, source review, and static scans remain useful review inputs. They do not close any item in this release gate.
