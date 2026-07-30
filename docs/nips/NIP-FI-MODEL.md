# Scope

This model specifies a relay or HTTP service authorizing a Nostr principal only when a valid federated identity assertion and a valid Nostr proof resolve to the same active identity-to-key binding. It models authorization, enrollment, revocation, and key rotation. It does not publish the federated identity on Nostr and does not make the identity provider a Nostr signing authority.

The model is transport-independent. A concrete NIP must separately define how an assertion reaches a verifier and how support is advertised. NIP-42 and NIP-98 remain the mechanisms for proving control of a Nostr key; a bearer assertion alone is never a Nostr proof.

# Terms and domains

- `D`: authorization domain resolved by the verifier from authenticated server routing or configuration (for example one relay tenant). An assertion, proof, header, or other untrusted request input cannot select or rewrite it, and bindings never cross domains implicitly.
- `I`: federated principal, the tuple `(iss, sub)`. `iss` is the assertion's exact validated issuer identifier and `sub` is its exact non-empty subject string. A username, email, display name, or bare `sub` is not an identity key.
- `K`: 32-byte Nostr public key.
- `A`: federated assertion.
- `P`: Nostr proof authenticating key `k`, such as a valid NIP-42 AUTH event or NIP-98 event.
- `now`: verifier time.
- `B_D`: active binding relation in domain `D`, a partial bijection between `I` and `K`.
- `P_D`: durable set of retired exact pairs `(i, k)`.
- `X_D`: durable set of disabled identities `i`.
- `Y_D`: durable set of revoked keys `k`.
- `Q_D`: pending explicit replacements, mapping an identity `i` to its retired key `k_old`.
- `H_D`: immutable lifecycle audit history; it is not an authorization input by itself.
- `mode(D)`: enrollment policy, either `attested-key`, `provisioned`, or `tofu`.

A binding record is:

```text
Binding = (domain, identity, key, source, created_at)
source  = attested-key | provisioned | tofu
```

`P_D`, `X_D`, `Y_D`, and `Q_D` are semantic authorization state, not a required database schema. A conforming implementation may derive them from immutable lifecycle records as long as `Authorize` can read their effective values atomically with `B_D`.

`display_name`, email, and similar values may be stored as mutable metadata but are never part of binding identity or an authorization decision.

# Trust assumptions

1. The verifier has an authenticated configuration for each accepted issuer: issuer identifier, allowed signing algorithms, key source, accepted audience(s), and optional Nostr-key and display-name claim mappings.
2. TLS and/or a trusted ingress boundary prevents attackers from injecting or replacing assertions. A reverse-proxy assertion header is trusted only when untrusted clients cannot reach the verifier directly and all inbound copies of that header are stripped before the trusted proxy sets it.
3. The issuer protects its signing keys and assigns stable, non-reassignable `sub` values within an issuer. If an issuer reassigns a subject, the model cannot distinguish the people.
4. The Nostr signature primitive is unforgeable and the concrete Nostr proof is fresh and bound to the target relay or HTTP request.
5. Binding-state transactions are serializable with respect to the same domain, identity, or key. The implementation may realize this with locks and unique constraints.
6. The verifier's clock is sufficiently accurate for assertion and proof freshness checks.

Compromise of an accepted issuer or trusted ingress can impersonate federated principals. It still cannot satisfy Nostr proof for an already-bound uncompromised key, and in `attested-key` mode it cannot bind an arbitrary key unless the compromised issuer also attests that key. Theft of an assertion alone cannot authorize an already-bound identity without control of the bound Nostr key.

# Assertion validity

Let `ValidateAssertion(A, C, now)` return either `(i, k_a?, exp)` or failure under issuer configuration `C`.

It succeeds only if all of the following hold:

1. the signature validates under a currently trusted key and an explicitly allowed asymmetric algorithm;
2. `A.iss` exactly equals the configured issuer identifier used to select that key;
3. at least one `A.aud` value exactly equals an audience configured for this service;
4. `exp` exists and `now < exp`, allowing only a bounded configured clock skew;
5. if present, `nbf <= now + configured_skew` and `iat <= now + configured_skew`;
6. `A.sub` is an unambiguous non-empty string;
7. `i = (A.iss, A.sub)`; and
8. if a configured Nostr-key claim is present, it parses to exactly one 32-byte key `k_a` (hex on the wire; bech32 may be accepted only as an explicitly documented input normalization).

Unknown issuers, key IDs, algorithms, claims, and validation failures fail closed. Key retrieval failure also fails closed. A verifier must bound key-cache lifetime and refresh behavior; it must not accept a token merely because parsing succeeded.

# Nostr-proof validity

`ValidateProof(P, target, now) = k` only when the applicable Nostr standard verifies the event ID and Schnorr signature, freshness, and target binding:

- NIP-42: kind, challenge, relay URL, and timestamp are valid; or
- NIP-98: kind, absolute request URL, HTTP method, timestamp, and payload hash when required are valid.

A service may define another proof profile only if it has equivalent signer-control, freshness, and target/replay binding. The key used for the authorization decision is the key returned by proof validation, never an unsigned request field or assertion display claim.

# Binding invariant

For every domain `D`, active bindings are one-to-one:

```text
∀ i, k1, k2: (i, k1) ∈ B_D ∧ (i, k2) ∈ B_D ⇒ k1 = k2
∀ i1, i2, k: (i1, k) ∈ B_D ∧ (i2, k) ∈ B_D ⇒ i1 = i2
```

Equivalently, an active identity has at most one key and an active key has at most one identity in a domain.

Base V1 therefore represents one active principal key per domain. Multiple devices share that key or use bounded delegation; a simultaneous active key set requires a future protocol extension.

Active bindings also satisfy the lifecycle invariants:

```text
(i, k) ∈ B_D ⇒ (i, k) ∉ P_D
(i, k) ∈ B_D ⇒ i ∉ X_D
(i, k) ∈ B_D ⇒ k ∉ Y_D
(i, k) ∈ B_D ⇒ i ∉ dom(Q_D)
i ∈ dom(Q_D) ⇒ no active binding exists for i
```

# Authorization and enrollment transition

Given trusted server-resolved domain `D`, assertion result `(i, k_a?, exp)`, and proof result `k`, evaluate one atomic transaction:

```text
Authorize(D, i, k_a?, k):
  if k_a exists and k_a != k:
      DENY(key_mismatch)

  atomically read:
    b_i := active binding in B_D for i, if any
    b_k := active binding in B_D for k, if any
    p   := (i, k) ∈ P_D
    x   := i ∈ X_D
    y   := k ∈ Y_D
    q   := i ∈ dom(Q_D)

  if b_i = (i, k) and b_k = (i, k) and not (p or x or y or q):
      ALLOW(existing)

  if b_i exists or b_k exists:
      DENY(binding_conflict)

  if x: DENY(identity_disabled)
  if y: DENY(key_revoked)
  if p: DENY(pair_retired)
  if q: DENY(explicit_replacement_required)

  switch mode(D):
    attested-key:
      if k_a is absent: DENY(key_attestation_required)
      atomically insert (i, k, attested-key) into B_D
      ALLOW(created)
    provisioned:
      DENY(binding_required)
    tofu:
      atomically insert (i, k, source = k_a exists ? attested-key : tofu) into B_D
      ALLOW(created)
```

If a concurrent attempt finds the identical committed binding, it allows as `existing`; if the committed outcome cannot be read or active or lifecycle storage is unavailable, deny — never fall back to an unchecked allow. The active-binding and lifecycle-gate reads and possible insertion must be linearizable for `(D, i)` and `(D, k)` and serialize with every lifecycle transition affecting them.

The resulting authorization lease is:

```text
L = (D, i, k, expires_at)
expires_at <= min(assertion.exp, policy_expiry?, delegation_expiry?, implementation_limit?)
```

Unknown optional bounds are omitted from the minimum. A lease authorizes only policy-selected operations in `D`; it does not authorize signing and does not imply that event authors may differ from `k`. Its continued eligibility also depends on every binding and lifecycle selector read by the decision.

# Session behavior

For a single HTTP request, the assertion, Nostr proof, and authorization decision apply only to that request.

For a NIP-42 WebSocket connection, a relay may cache `L`, but it must not use the lease after `expires_at`. It must reject protected operations or terminate the connection. Renewal requires a new WebSocket connection carrying a fresh assertion on its upgrade request, followed by fresh NIP-42 proof; base V1 has no in-connection renewal transition. A relay that learns that a binding, identity, key, policy decision, or delegation dependency is no longer valid must invalidate every matching direct and delegated lease. Implementations must document their maximum revocation-detection latency; they cannot claim immediate revocation if they only poll.

If multiple keys authenticate on one NIP-42 connection, authorization is tracked independently per key. A lease for one `(i, k)` must not authorize another authenticated key.

# Revocation and rotation

Pair retirement is an explicit administrative transition:

```text
RetirePair(D, i, k):
  require (i, k) ∈ B_D
  atomically:
    remove (i, k) from B_D
    add (i, k) to P_D
    set Q_D(i) = k
    append the transition to H_D
  invalidate cached leases for the binding as soon as observed
```

Identity disablement and key revocation may occur before enrollment and are independent of pair retirement:

```text
DisableIdentity(D, i):
  atomically:
    add i to X_D
    if (i, k) ∈ B_D:
      remove (i, k), add (i, k) to P_D, and clear Q_D(i)
    append the transition to H_D
  invalidate direct and dependent delegated leases for i

RevokeKey(D, k):
  atomically:
    add k to Y_D
    if (i, k) ∈ B_D:
      remove (i, k), add (i, k) to P_D, and set Q_D(i) = k
    append the transition to H_D
  invalidate every direct or delegated lease that depends on k
```

An assertion, including one with `k_a = k`, cannot clear `P_D`, `X_D`, `Y_D`, or `Q_D` and cannot invoke a recovery transition. This prevents replay of a still-valid assertion and presentation of an unbound replacement key from undoing revocation.

Rotation or recovery is a separate privileged transition, not an authorization side effect:

```text
RotateOrRecover(D, i, k_old, k_new):
  require explicit recovery/admin authorization
  require (i, k_old) ∈ B_D or Q_D(i) = k_old
  require i ∉ X_D
  require k_new ∉ Y_D
  require (i, k_new) ∉ P_D
  require no active binding for k_new
  if issuer-attested rotation is required, require fresh k_a = k_new
  atomically remove any active (i, k_old), add (i, k_old) to P_D,
    add k_old to Y_D, create (i, k_new), and clear Q_D(i)
  append the transition to H_D
  invalidate leases for k_old
```

A normal request that presents `i` with `k_new` while `k_old` is active is a conflict. If `i` is pending replacement, it denies `explicit_replacement_required`. Neither path rotates automatically. Base V1 recovery uses a fresh, non-retired key; same-key reactivation requires an extension with an equivalently explicit privileged transition and retained lifecycle history.

# Delegation

Delegation is outside the base identity-binding primitive. A separate delegation standard may allow a bound owner key to authorize a delegate key. If supported, the verifier must first validate the delegation proof and derive the owner key, then require an active owner binding or unexpired owner authorization lease. It must not create the owner's federated identity binding for the delegate. The delegated decision retains the owner dependency, intersects the delegation's operations and conditions, expires at the earliest owner, delegation, policy, or implementation bound, and is invalidated when the owner binding is retired or revoked. A deployment may add a stronger current-provider admission requirement for the owner without changing this base primitive.

# Safety properties

Under the trust assumptions, for direct (non-delegated) authorization:

1. **Proof possession:** every allowed protected operation is associated with a valid proof of control of its Nostr key.
2. **Federated authenticity:** every allowed protected operation is associated with a currently valid assertion for its issuer-qualified identity.
3. **Agreement:** if the issuer supplies a key claim, the asserted key, proven key, and bound key are equal.
4. **Binding consistency:** no two active identities share a key and no identity has two active keys in one domain.
5. **No implicit rotation:** conflicting assertions or proofs cannot replace an active binding.
6. **No replayed resurrection:** ordinary authorization cannot recreate a retired pair or replace a key for an identity pending explicit replacement.
7. **Lifecycle closure:** a disabled identity cannot authorize any key, and a revoked key cannot authorize or bind to any identity.
8. **Lifecycle consistency:** active bindings satisfy the partial-bijection and lifecycle invariants above.
9. **Rotation atomicity:** observers see either the valid old state or the completed replacement, never a partial transition; lifecycle history is retained.
10. **Linearizable lifecycle:** authorization racing a lifecycle transition cannot commit a binding that violates the completed transition.
11. **Domain separation:** authorization in one domain does not imply authorization in another.
12. **Lease boundedness:** no cached authorization survives its earliest assertion, policy, delegation, or implementation bound; after a dependency change is observed, no matching direct or delegated lease remains valid.
13. **Fail-closed storage and verification:** validation, key retrieval, or binding-state failures never produce allow.
14. **Privacy:** NIP-FI protocol behavior never publishes `iss`, `sub`, JWTs, email, or display names in Nostr events or relay-visible event history. A separate opt-in relay-signed projection may publish an approved label, but never those private values and never as authorization evidence.

# Liveness properties

Assuming the issuer, key source, binding store, and network are available:

1. a valid assertion and matching proof for an eligible existing active binding are eventually authorized;
2. a never-retired pair with no applicable identity, key, or pending-replacement gate is eventually authorized exactly once when the configured enrollment mode permits it;
3. after `RotateOrRecover` commits and bounded cache invalidation completes, the replacement binding is eventually authorized and the old pair and key remain denied.

No authorization liveness is promised while identity disablement, key revocation, pair retirement, or pending replacement blocks a request. Liveness is also intentionally not guaranteed during issuer/JWKS/storage outage; availability must not override identity safety.

# Conformance traces

The companion [NIP-FI conformance matrix](NIP-FI-CONFORMANCE.md) defines stable-ID success, denial, concurrency, lifecycle, session, delegation, disclosure, and privacy traces. In particular, its revoked-pair replay trace requires a stable denial with no mutation even when the still-valid assertion carries a matching key claim; only the separately authorized replacement transition can restore authority.

# Conformance hooks for the NIP

The normative NIP should expose enough information for clients and operators to determine:

- accepted assertion transport profile(s);
- issuer discovery or configured issuer and accepted audience rules without leaking private tenant data;
- whether a key claim is required;
- enrollment mode (`attested-key`, `provisioned`, or explicitly risk-labeled `tofu`);
- authorization lease/re-authentication behavior;
- machine-readable rejection classes using existing NIP-42 `auth-required:` and `restricted:` prefixes where applicable;
- privacy requirements and trusted-proxy deployment requirements.

It should not standardize database schema, lock mechanism, Okta-specific claims, mutable display metadata, or an administration API. Those are implementation choices as long as the invariants and transitions above hold.

# Sources

- NIP-42 authentication: https://github.com/nostr-protocol/nips/blob/8f8444d05a8842c40211ded5d10af3521541f865/42.md
- NIP-98 HTTP auth: https://github.com/nostr-protocol/nips/blob/8f8444d05a8842c40211ded5d10af3521541f865/98.md
- NIP-05 issuer-controlled identifier mapping precedent: https://github.com/nostr-protocol/nips/blob/8f8444d05a8842c40211ded5d10af3521541f865/05.md
- NIP-46 external auth challenge precedent: https://github.com/nostr-protocol/nips/blob/8f8444d05a8842c40211ded5d10af3521541f865/46.md
- Companion protocol specification: [`NIP-FI.md`](NIP-FI.md)
- Companion conformance matrix: [`NIP-FI-CONFORMANCE.md`](NIP-FI-CONFORMANCE.md)
- Buzz PR #1476 at `1e9822de8dbe0ae91c00c0ce0ed8ff583915692f` is a disabled partial foundation, not a complete NIP-FI implementation; future-`iat`, discovery, lifecycle, and lease conformance remain additive work.
