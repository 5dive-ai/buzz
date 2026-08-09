# NIP-FI stock deployment

This guide describes a provider-neutral stock deployment for the normative [NIP-FI contract](nips/NIP-FI.md). It does not define runtime configuration keys or activate support.

## Current status

This documentation revision ships no NIP-FI runtime adapter, configuration schema, image capability, or conformance report. The current Compose and Helm bundles must not advertise or enforce NIP-FI. A later implementation release must document its exact adapter and configuration surface and pass the [behavioral evidence matrix](nips/NIP-FI-CONFORMANCE.md) at the deployed revision before activation.

The files under [`docs/examples`](examples/) are review templates. They are not accepted runtime schemas and contain no deployable secrets.

## Stock topology

```text
external client
  -> TLS listener or trusted edge
  -> Buzz verifier ingress
  -> one canonical NIP-FI verifier and final-admission authority
  -> binding/lifecycle, replay, policy, receipt, audit, and application stores
                    |
                    -> configured issuer metadata and JWKS over authenticated TLS
```

The stock profile is provider free. It identifies issuers by exact configured values and retrieves keys under bounded policy. It does not require a provider-specific sidecar, claim dialect, SDK, or forwarded-identity convention.

## Activation prerequisites

Do not publish NIP-FI discovery or enable enforcement until all of these are true for one immutable claim tuple:

1. The running artifact supplies a canonical verifier, final-admission authority, lifecycle state, and executable adapter manifest.
2. Every protected WebSocket and HTTP ingress appears in the executed route inventory.
3. One current domain policy and policy lineage covers every protected ingress.
4. Issuer, audience, algorithm, claim, time, size, JWKS, and enrollment policy is explicit for each domain.
5. Binding, lifecycle, replay, receipt, audit, invalidation, and application storage meets serialization and durability requirements.
6. Secrets arrive from an access-controlled secret store and never from repository examples.
7. Backup, restore, key rotation, dependency outage, recovery, and rollback exercises pass.
8. All applicable `FI-TRACE-*` rows pass at the exact implementation, adapter, artifact, deployment, and policy digests.

A source scan, config parse, rendered manifest, healthy process, or documentation link closes none of these gates.

## Domain policy

Use one reviewed policy object per server-selected domain. The review-only [stock domain example](examples/nip-fi-stock-domain.json.example) records the required decisions without claiming a runtime schema.

At minimum, the later runtime schema must represent:

- exact domain identity and trusted listener or route mapping;
- accepted issuer and audience values;
- allowed compact-JWS algorithms and compatible key types;
- subject and optional Nostr-key claim rules;
- assertion, clock-skew, header, and body bounds;
- JWKS refresh, stale-on-error, and hard-validity bounds;
- exactly one enrollment mode;
- accepted assertion transports;
- delegation support and positive finite maximum, when enabled;
- stable public denial mapping; and
- current policy identity and lineage.

Rotating verification keys changes the JWKS generation, not the stable verifier-policy identity. Changing accepted assertion semantics creates a new policy identity.

## Client-attached profile

Expose `client-attached` only where the client can send exactly one `Nostr-Federated-Identity: Bearer <JWT>` field and fresh Nostr proof through one protected request flow. Use that assertion field for both WebSocket upgrades and HTTP requests. Never accept the federated assertion in `Authorization`. Reject assertion-provenance fields on this profile and never fall back to it after trusted-proxy evidence is missing, mixed, or invalid.

Treat assertions as confidential bearer material. Do not log headers, echo them in errors, retain them in public history, or forward them beyond the canonical verifier.

## Trusted-proxy profile

The Buzz stock trusted-proxy profile is `trusted-proxy-hmac-v1`. The edge:

1. removes every inbound assertion and provenance field, including attacker-supplied duplicates;
2. completes trusted routing and canonical path rewriting;
3. computes the assertion digest and request body digest;
4. creates a fresh timestamp and nonce;
5. MACs the exact timestamp, nonce, assertion digest, method, authority, path/query, and body digest; and
6. sends exactly one `Nostr-Federated-Identity: Bearer <JWT>` field and one `Nostr-Federated-Identity-Provenance` field to verifier ingress.

The HMAC secret is random, access controlled, versioned, and delivered independently of application configuration. Rotation uses a short, explicit overlap. Replay uniqueness is scoped to the trusted-proxy domain, profile, and nonce and is independent of which active secret verified the MAC. A nonce re-signed with another active secret remains a replay. The matched secret version may appear only in private audit metadata. Remove the old version after all requests and replay windows expire.

Network controls ensure that only the trusted edge can reach verifier ingress. A separate health or administrative listener cannot proxy protected operations. The deployment test runs direct-origin, bypass, client-header injection, mixed-profile, replay, and cross-request mutations from both sides of the boundary. A mocked listener test cannot satisfy `FI-TRACE-PROXY-SPOOF`.

## Storage and transactions

Production-equivalent storage must provide:

- serialized uniqueness for both sides of each domain's active binding relation;
- durable lifecycle selectors and immutable typed history;
- monotonic binding and lifecycle versions;
- atomic enrollment, replay claim, request-bound receipt, and required audit evidence;
- idempotent application consumption when the application effect uses another transaction;
- bounded replay retention that outlives the accepted provenance window;
- current policy, JWKS generation, resource, and relationship witnesses; and
- backup and restore consistency across authority state.

Caching may improve reads but cannot authorize from state older than its witnessed invalidation bound. An unavailable cache origin, database, replay store, receipt store, or audit sink denies.

## Rollout

### 1. Inventory

List every protected ingress and its current authorization path. Include WebSocket operations, HTTP event/query/count, media, Git, audio, invite, moderation, and operator paths. Remove or fail startup on uncovered and competing authorities.

### 2. Install without discovery

Deploy the exact implementation artifact with NIP-FI discovery and enforcement off. Load reviewed policy and secret references. Validate issuer connectivity, JWKS authenticity, state migrations, backup, observability redaction, and route inventory without creating production bindings.

### 3. Run isolated behavior

Run every applicable adapter in an isolated namespace using synthetic issuers, identities, keys, and domains. Retain commands, results, state snapshots, wire captures, sink scans, and artifact digests.

### 4. Exercise the deployed boundary

Run production-equivalent trusted-edge negative tests, dependency fault injection, restore, key rotation, concurrency, lifecycle, recovery, and rollback exercises. Do not infer these outcomes from isolated unit tests.

### 5. Activate atomically

Only after the exact claim tuple passes, publish discovery and enable one canonical authority for the complete protected-ingress set. Do not canary by leaving some protected routes under an older identity authority. Canary domains or isolated deployments instead.

### 6. Observe without identity leakage

Monitor aggregate allow/deny classes, dependency readiness, refresh age, replay pressure, final-admission conflicts, lease invalidations, and audit capacity. Private reason details stay access controlled. Raw assertions and identity claims are never metric labels or trace attributes.

## Rollback

Rollback means returning to a previously conformant artifact and compatible policy/state lineage, or disabling NIP-FI discovery and failing the protected operation closed. It does not mean accepting unsigned identity, restoring a removed verification key, deleting tombstones, rewinding lifecycle tables, bypassing audit, or running a legacy authority beside NIP-FI.

Before rollout, record compatible artifact, policy, migration, and storage checkpoints. If a schema or semantic change is not backward compatible, use a reviewed forward repair or compensating privileged transition. Follow the [runtime operations guide](NIP_FI_RUNTIME_OPERATIONS.md) for authority-state recovery.

## Compose and Helm

The current [Compose](../deploy/compose/README.md) and [Helm](../deploy/charts/buzz/README.md) bundles contain no NIP-FI adapter wiring. Their NIP-FI sections are readiness statements, not activation instructions.

A later bundle must:

- pin the exact implementation artifact and expose its adapter/config version;
- mount domain policy and secret references without putting secrets in values or examples;
- isolate trusted edge and verifier ingress when the proxy profile is enabled;
- provide readiness that covers every fail-closed dependency;
- name the backup, restore, migration, and rollback procedures; and
- link the matching immutable conformance report.

## Deployment record

For each enforcing environment, retain the immutable claim tuple, policy and artifact digests, route inventory, accepted profiles, enrollment mode, delegation posture, secret versions without secret values, storage topology, executed adapter report, restore exercise, activation time, and rollback target.
