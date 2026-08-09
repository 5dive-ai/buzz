# NIP-FI threat model

This document records the security model for Buzz implementations of the normative [NIP-FI specification](nips/NIP-FI.md) and [formal model](nips/NIP-FI-MODEL.md). It is non-normative. The [conformance evidence matrix](nips/NIP-FI-CONFORMANCE.md) defines the behavioral release gate.

## Current status

This documentation revision contains no NIP-FI runtime adapter and establishes no conformance claim. The threats and mitigations below become implementation claims only when a later exact-head implementation and deployment tuple passes every applicable `FI-TRACE-*` behavior.

## Security objectives

NIP-FI adds issuer-qualified identity to fresh Nostr key proof without making either one sufficient by itself. Its security objectives are:

- bind authority to one server-selected domain, route, operation, resource, and actor key;
- accept an assertion only under one provider-neutral verifier policy and current key snapshot;
- make trusted-proxy identity cryptographically request bound and replay resistant;
- keep durable identity/key bindings independent of assertion lifetime;
- preserve retirement, disablement, revocation, replacement, and provenance across ordinary authorization;
- keep preparation read-only and make final admission the only authority commit point;
- bound sessions and delegation by every current dependency;
- deny on unreadable, ambiguous, stale, or contradictory state; and
- prevent identity material and detailed decision reasons from becoming public or observable.

## Protected assets

| Asset | Required protection |
|---|---|
| Assertions and confidential revalidation handles | Confidentiality, integrity, bounded retention, and no public projection |
| Fresh Nostr proofs and proven actor keys | Request binding, freshness, and separation between keys on one connection |
| Trusted-proxy HMAC keys, timestamps, and nonces | Secret delivery, canonical request binding, replay retention, and rotation |
| Server-selected domain and request context | Integrity against host, forwarded-field, path, query, and body substitution |
| Verifier policy and JWKS generations | Stable semantic identity, authentic refresh, hard expiry, and current-key revalidation |
| Binding and lifecycle state `B`, `T`, `X`, `Y`, `Q`, `H`, and `V` | Serialization, durability, monotonic lineage, and backup consistency |
| Prepared evidence, receipts, replay claims, and audit evidence | Integrity, idempotence, privacy, and atomic final admission |
| Leases, delegation, and invalidation state | Finite bounds and current owner, key, policy, and resource dependencies |
| Conformance reports and artifacts | Exact-revision provenance, digest integrity, completeness, and reproducibility |

## Actors and trust boundaries

- **Client:** controls all request fields and may hold a valid assertion, a Nostr key, both, or neither.
- **Trusted edge:** for `trusted-proxy-hmac-v1`, terminates the external request, strips inbound identity fields, and creates the request-bound HMAC envelope.
- **Buzz ingress:** selects the domain and route from trusted configuration, verifies transport evidence, and invokes one final-admission authority.
- **Issuer and JWKS endpoint:** assert identity and publish verification keys. They are trusted only within configured policy and freshness bounds.
- **State services:** store binding, lifecycle, replay, receipt, audit, policy, relationship, and application state.
- **Operator:** controls deployment policy and privileged lifecycle transitions. Operator authority is not ordinary user authority.
- **Evidence runner:** drives production-equivalent behavior and retains privacy-safe conformance artifacts for one immutable claim tuple.

The external client-to-edge, edge-to-origin, origin-to-issuer, process-to-storage, operator-to-lifecycle, and test-runner-to-deployment boundaries are independent. Trust at one boundary does not replace authentication at another.

## Attacker capabilities

The model assumes an attacker can:

- send arbitrary HTTP and WebSocket traffic, headers, authority values, paths, query strings, bodies, events, and Nostr keys;
- reach any listener exposed by deployment, replay captured traffic, race enrollment and lifecycle operations, and hold connections across rotations;
- steal a bearer assertion without stealing its user's Nostr key, or steal a Nostr key without obtaining a valid assertion;
- choose equal subjects across issuers and collide inputs across domains;
- trigger issuer, JWKS, database, replay, policy, receipt, audit, and network outages; and
- observe public responses and externally exported logs, metrics, and traces.

The model does not assume that source IP, header presence, a private subnet, or a function name proves trusted provenance or authorization.

## Threats and required evidence

| Threat | Security effect | Required control | Behavioral evidence |
|---|---|---|---|
| Forged or unsigned forwarded identity | Assertion accepted without a trusted edge | Accept only the complete request-bound HMAC profile; reject direct, missing, mixed, and client-injected provenance | `FI-TRACE-PROXY-SPOOF` |
| Proxy nonce replay | Duplicate authorization or application effect | Retain nonce state through final admission and commit replay claim with receipt and authority state | `FI-TRACE-PROXY-REPLAY`, `FI-TRACE-FINAL-DENIAL-NO-MUTATION` |
| Cross-request HMAC reuse | Identity transplanted to another operation | MAC the timestamp, nonce, assertion digest, method, authority, path/query, and body digest using exact canonical bytes | `FI-TRACE-PROXY-CROSS-REQUEST` |
| Domain or route confusion | Authority crosses tenants or bypasses policy | Resolve context from trusted listener and route state; reject uncovered or different-lineage authorities | `FI-TRACE-DOMAIN-SPOOF`, `FI-TRACE-AUTHORITY-UNIFORM`, `FI-TRACE-CROSS-DOMAIN-COLLISION` |
| Transport-specific verifier drift | A weaker ingress accepts a rejected assertion | Use one canonical verifier and run one corpus through every transport adapter | `FI-TRACE-VERIFIER-PARITY` |
| JWKS rotation race or stale key use | Removed keys continue to authorize, or retained keys fail unpredictably | Separate policy identity from JWKS generation and revalidate prepared evidence and leases on generation change | `FI-TRACE-JWKS-ADD`, `FI-TRACE-JWKS-REMOVE` |
| Assertion/key substitution | Issuer identity attaches to an unproven key | Require fresh Nostr proof and equality with any asserted key claim | `FI-TRACE-ASSERTION-KEY-MISMATCH` |
| Binding takeover or concurrent first use | One identity or key silently replaces another | Serialize both sides of the partial bijection and commit at most one conflicting enrollment | `FI-TRACE-BINDING-CONFLICT`, `FI-TRACE-CONCURRENT-ENROLLMENT` |
| Tombstone bypass | Retired, disabled, revoked, or pending lineage reappears | Check every active lifecycle selector before enrollment and preserve lineage durably | `FI-TRACE-TOMBSTONE-REPLAY` |
| Assertion expiry confused with binding expiry | A durable binding disappears or is recreated with different provenance | Keep binding lifetime independent; treat administrative expiry as a separate privileged field | `FI-TRACE-ASSERTION-REFRESH`, `FI-TRACE-ADMIN-EXPIRY` |
| Stale prepared decision or time-of-check/time-of-use race | Changed request or authority state commits under old evidence | Keep preparation read-only; seal witnesses; reread applicable dependencies at final admission | `FI-TRACE-PREPARED-STALE`, `FI-TRACE-FINAL-DENIAL-NO-MUTATION` |
| Stolen assertion first use | Attacker enrolls its key for a new identity | Prefer attested or provisioned enrollment; expose TOFU only as explicit risk-labelled policy | `FI-TRACE-TOFU-THEFT` |
| Delegation survives owner change or expiry | Former or expired owner authority persists | Bind delegation to exact current owner version and a positive finite deadline | `FI-TRACE-DELEGATE-OWNER-ROTATED`, `FI-TRACE-DELEGATION-EXPIRED` |
| Cross-key session confusion | One key's lease authorizes another key | Key leases by actor, domain, capability, resource, and dependency set | `FI-TRACE-MULTI-KEY-SESSION` |
| Public decision oracle | Identity or private policy can be enumerated | Map private reasons to stable many-to-one public denial classes | `FI-TRACE-DENIAL-ORACLE` |
| Identity leakage | Assertions or claims enter public events or observability | Minimize private state and scan protocol output plus every configured sink with canaries | `FI-TRACE-PRIVACY-NONPUBLIC` |
| Dependency outage or contradictory state | Availability failure becomes an authorization bypass | Bound work, alert, and fail closed at preparation, final admission, and lease reuse | `FI-TRACE-DEPENDENCY-FAIL-CLOSED` |
| Evidence substitution | A report from another revision is used to activate enforcement | Bind reports and artifact digests to one immutable claim tuple and fail on missing or duplicate traces | Complete exact-head matrix validation |

## Enrollment risk

Attested enrollment resists bearer-assertion theft only when the issuer's key claim is itself trustworthy and equals the independently proven key. Provisioned enrollment moves creation to an explicit privileged transition but still requires target-key proof. TOFU accepts the first proven key for a never-enrolled identity and therefore cannot prevent first-use theft by an attacker holding a valid bearer assertion.

Changing enrollment mode does not repair or reclassify existing bindings. Operators must use an authorized lifecycle transition and preserve the original provenance history.

## Availability and resource exhaustion

Fail-closed behavior deliberately trades availability for authorization safety. Attackers may amplify issuer refresh, signature verification, replay lookup, audit writes, or policy reads. Implementations bound assertion and header sizes, canonicalization work, clock skew, JWKS refresh, replay retention, concurrency, queues, and observability work. A full or unavailable audit or replay store denies instead of silently dropping evidence.

Rate limits cannot replace cryptographic verification, lifecycle selectors, or final-admission serialization.

## Residual risk

The protocol cannot eliminate:

- compromise or malicious behavior by an accepted issuer within its configured claims;
- compromise of the trusted edge, an active HMAC key, the Buzz process, storage credentials, or privileged operator authority;
- first-use theft in risk-labelled TOFU mode;
- denial of service caused by required dependencies failing closed;
- correlation visible to systems that legitimately process private identity state; or
- an implementation defect that the exact behavioral matrix does not exercise.

Use short-lived and narrowly scoped secrets, separation of duties, access-controlled audit, independent artifact retention, and periodic reruns to reduce these risks.

## Out of scope

NIP-FI does not define provider setup, account recovery at an issuer, public identity projection, a public profile event, human-resources policy, or a mechanism for trusting unsigned corporate headers. Those concerns cannot add an alternate authorization path.

## Review triggers

Review this threat model and rerun affected traces when a change adds an ingress, transport, issuer rule, accepted algorithm, claim, enrollment mode, lifecycle transition, delegation capability, state dependency, cache, lease, proxy hop, observability sink, restore process, or rollback path.
