NIP-FI
======

Federated identity authorization
--------------------------------

`draft` `optional` `relay`

**Protocol dependencies**: NIP-01, plus NIP-42 for WebSocket authorization or NIP-98 for HTTP authorization. **Optional composition**: NIP-11 discovery and a separately validated delegation protocol such as NIP-OA.

## Abstract

This NIP defines how a relay or Nostr-adjacent HTTP service authorizes a Nostr key only when a valid federated identity assertion, fresh Nostr proof, current identity-to-key binding state, and the requested operation's local admission policy all agree. It defines cryptographically bound assertion transport, assertion and proof validation, read-only authorization preparation, final admission, enrollment, lifecycle state, bounded sessions, delegation, rejection behavior, discovery, and privacy.

The identity provider never becomes a Nostr signing authority. A bearer assertion never substitutes for Nostr proof of key control. Binding lifetime is independent of assertion lifetime: a fresh assertion can authorize an existing eligible binding after an earlier assertion expires, while every authorization lease remains bounded by the assertion used to create it.

## Motivation

Organizations may need relay access tied to an external identity system while preserving Nostr key ownership. NIP-42 proves control of a key on a relay connection, and NIP-98 proves control of a key for an HTTP request, but neither binds that key to an issuer-qualified external principal. Without a shared contract, deployments can disagree about assertion transport, key rotation, enrollment, lifecycle denial, and the point at which authorization may mutate state.

This NIP defines a provider-neutral contract. It does not standardize an identity vendor, database schema, operator API, public identity projection, or application-specific membership policy.

## Definitions

- **assertion** (`A`): a JWT issued under an accepted verifier policy and presented as independent evidence alongside Nostr proof.
- **federated identity** (`i`): the exact tuple `(iss, sub)` from a validated assertion. `iss` is the exact accepted issuer identifier. `sub` is the exact non-empty subject string. A username, email address, display name, employee number, mutable profile field, or bare `sub` is not a federated identity.
- **authorization domain** (`D`): a boundary selected from authenticated server routing and configuration. A client-supplied domain, forwarded host value, assertion claim, or unsigned header cannot select `D`.
- **target context** (`R_t`): the server-resolved method, authority, path and query, body digest, transport, operation, and resource for the request being admitted.
- **request context** (`R`): `R_t` sealed with the acting key returned by Nostr-proof validation. Client input cannot supply or replace that key.
- **verifier policy identity** (`policy_id`): a stable identifier for assertion semantics, including issuer, audience, allowed algorithms, authenticated key-source identity, claim and normalization rules, and time bounds. It MUST change when those semantics change and MUST NOT include transport, rotating signing-key contents, key-set order, cache timestamps, or a JWKS generation.
- **JWKS generation** (`g`): an opaque identifier for one effective verification-key snapshot. It MUST change whenever the accepted key identifiers or key material change.
- **binding**: a durable, versioned record associating one identity with one 32-byte Nostr public key in `D`. Its immutable provenance is `attested-key`, `provisioned`, or `tofu`. It MAY carry a separately authorized administrative `binding_not_after` bound. It MUST NOT derive that bound from assertion `exp` or `iat`.
- **retired pair**: a durable denial fact for one exact `(D, i, k)` pair. Ordinary authorization can never recreate that pair.
- **disabled identity**: a durable denial fact that prevents an identity from authorizing or enrolling a key.
- **revoked key**: a durable denial fact that prevents a key from authorizing or binding to any identity in `D`.
- **pending replacement**: durable lineage identifying an old key and binding version that a separately authorized recovery or re-enablement transition may consume once.
- **Nostr proof**: a valid NIP-42 AUTH event or NIP-98 event proving control of a key for the current connection or request.
- **prepared authorization**: an immutable, non-authoritative, read-only result that seals verified evidence, server-owned context, state and policy witnesses, a possible enrollment proposal, and every expiry and invalidation dependency. Preparation creates no binding, lifecycle fact, replay claim, receipt, audit event, publication, lease, or application mutation.
- **committed authorization**: the result of revalidating a prepared authorization at final admission and atomically committing any allowed enrollment, replay claim, receipt, and required authorization audit evidence.
- **lease**: a cached committed decision for one actor, domain, operation set, and exact dependency versions. A lease is never a binding and cannot extend one.

Within a domain, active bindings form a partial bijection: one identity has at most one active key, and one key has at most one active identity.

## Assertion transport

An assertion is captured on the request being authorized: the WebSocket upgrade for NIP-42 connections or the same HTTP request as its NIP-98 proof. Assertions MUST NOT appear in URLs, query parameters, Nostr events, tags, filters, application history, or public identity projections.

Two transport profiles are defined. A service MUST advertise and accept only profiles it implements completely.

### Client-attached profile

This profile's discovery identifier is `client-attached`. The client sends exactly one `Nostr-Federated-Identity: Bearer <JWT>` field and no assertion-provenance field. A documented WebSocket profile MAY use `Authorization: Bearer`, but a NIP-98 HTTP request MUST reserve `Authorization` for its `Nostr` proof. Missing, repeated, comma-combined, malformed, empty, non-Bearer, or mixed-profile assertion fields are rejected.

### Trusted-proxy HMAC profile

This profile's discovery identifier is `trusted-proxy-hmac-v1`. The trusted proxy strips every inbound copy of all assertion and provenance fields, inserts exactly one `Nostr-Federated-Identity: Bearer <JWT>` field, and inserts exactly one `Nostr-Federated-Identity-Provenance` field. Header presence, source IP, or network topology alone is not trusted-proxy provenance. Unsigned forwarded identity MUST be rejected.

The provenance field has this exact ASCII form:

```text
v1.<timestamp>.<nonce>.<mac>
```

`timestamp` is canonical unsigned decimal without leading zeroes, except that zero is `0`. `nonce` and `mac` are canonical unpadded base64url. The trusted proxy generates each nonce with at least 128 bits from a cryptographically secure random source. A decoded nonce contains at least 16 bytes, and a decoded MAC contains exactly 32 bytes. The verifier applies configured finite maximum provenance-field and nonce sizes before decoding, lookup, or replay storage. Missing, repeated, comma-combined, oversized, non-canonical, or extra components are malformed.

The stock profile uses HMAC-SHA-256 with a deployment secret of at least 256 bits. Let `LP(x)` be the eight-byte unsigned big-endian length of byte string `x`, followed by `x`. The MAC input is:

```text
"NIP-FI-PROXY-1" ||
LP(timestamp) || LP(nonce) || LP(assertion_digest) ||
LP(method) || LP(authority) || LP(path_and_query) || LP(body_digest)
```

For the MAC, parsed `timestamp` is encoded as an eight-byte unsigned big-endian value. `nonce`, `assertion_digest`, `body_digest`, and `mac` are their decoded bytes. `assertion_digest` is SHA-256 over the exact JWT octets after the Bearer scheme. `method` is the exact uppercase ASCII method token accepted by the endpoint. `authority` is the server-configured lowercase ASCII host, with an explicit decimal effective port and brackets around IPv6. `path_and_query` is the exact ASCII origin-form received after trusted routing: an empty path becomes `/`, the query includes its leading `?`, and percent-encoding, parameter order, and repeated parameters are preserved. It contains no fragment. A proxy rewrite is complete before these values are computed. Ambiguous or non-canonical values are rejected. `body_digest` is SHA-256 over the exact request body, including the empty body used by a WebSocket upgrade. The verifier compares the MAC in constant time.

The profile configures a positive finite `maximum_provenance_age` and a non-negative finite `future_skew`. It accepts time only when `timestamp <= now + future_skew` and `now < timestamp + maximum_provenance_age`, using overflow-safe comparisons. Equality at the age bound is expired.

The verifier MUST reject an absent, repeated, malformed, stale, future-dated, wrong-key, or mismatched provenance value. It MUST reject a committed nonce. A committed nonce is retained through at least `timestamp + maximum_provenance_age`; an applicable Nostr-proof replay identity is retained through its entire acceptance window. The nonce and proof replay identity become consumed only during final admission. The MAC therefore cannot be replayed across an assertion, method, authority, path, query, or body. Secret selection and rotation may try only a configured finite set of active secrets and fail closed when none verifies.

The proxy-to-verifier hop still requires confidentiality and integrity. Trusted listener and route configuration selects the profile in `R_t`. Direct ingress to a listener configured for this profile MUST reject assertion-bearing requests that lack valid provenance and MUST NOT fall back to `client-attached` after missing or rejected provenance.

## Assertion validation

For each accepted issuer, the verifier has authenticated configuration for the exact issuer identifier, accepted audiences, allowed asymmetric algorithms, key source, required `sub` semantics, optional Nostr-key claim, finite maximum assertion age, and bounded clock skew. Transport adapters supply assertion bytes but cannot change this contract. Validation enforces all of the following:

1. The input is exactly one bounded compact JWS. Protected-header and claim member names are unambiguous. Unknown critical headers, `none`, symmetric algorithms, algorithm and key-type mismatch, and incompatible JWK `use` or `key_ops` are rejected before signature acceptance.
2. The signature verifies under exactly one currently accepted asymmetric key and explicitly allowed algorithm. A duplicate or ambiguous `kid` fails. A missing `kid` is accepted only when policy deterministically selects exactly one compatible key.
3. `iss` exactly equals the configured issuer used to select the policy and key source.
4. At least one `aud` value exactly equals an accepted audience.
5. `exp` and `iat` are finite numeric dates. The verifier requires `now < exp`, `iat <= now + skew`, and `now < iat + maximum_assertion_age`, using overflow-safe comparisons. An optional `nbf` requires `nbf <= now + skew`. Equality at an expiry or maximum-age bound is expired.
6. `sub` is a non-empty exact string and the issuer contract guarantees that it is stable, opaque, non-reassignable, and not intentionally derived from a profile or personally identifying claim.
7. If a Nostr-key claim is configured and present, it resolves unambiguously to one 32-byte public key. Lowercase hexadecimal is canonical. Any additional accepted encoding must normalize to that value without ambiguity.

The verifier bounds assertion, header, claim, subject, key-identifier, and configured key-set sizes before lookup or observability. Attacker-controlled values, including `kid`, are never emitted unsanitized.

The validated result seals `i`, an optional asserted key `k_a`, the assertion deadline, `policy_id`, JWKS generation `g`, the verification-key identity, the key snapshot's hard-validity deadline, and confidential revalidation material that can recover the exact compact-JWS bytes. Display names, email addresses, and other profile claims do not enter this result.

Verifier-policy identity is independent of key rotation. Adding, overlapping, or removing issuer keys changes `g`, not `policy_id`. Final admission MUST deny if the current verifier policy identity differs from the prepared identity. Evidence prepared under generation `g_old` MUST be revalidated against the current key snapshot before final admission if the generation changed. Revalidation must reproduce the same identity, asserted key, policy identity, and live time bounds. A removed key, rollback to an unaccepted generation, unreadable current generation, or failed revalidation denies admission. A normal overlapping key rotation therefore does not require a new binding or policy lineage.

Signing-key retrieval fails closed. Refresh work MUST be bounded and coalesced. An unknown `kid` cannot trigger unbounded per-request retrieval and has no stale-key fallback. A previously known key MAY be used after a soft refresh failure only under a documented finite stale-known-key policy and never after its hard maximum age.

## Nostr proof and server-owned context

The authorized key is always returned by Nostr proof validation, never by an assertion claim or unsigned field.

- NIP-42 validation binds the AUTH event to the current challenge, relay URL, connection, and freshness window.
- NIP-98 validation binds the event to the exact server-resolved absolute request URL, method, payload digest when required, and freshness window.

The service resolves `D`, operation, resource, transport, and authority from trusted server state. All evidence must agree with that same context. Unknown routes, effects, resources, domains, or transport provenance deny before preparation can become authority.

Every protected ingress in a domain MUST use one canonical current domain policy and final-admission authority. A route with no such authority, a competing authority, or an authority at a different policy lineage makes enforcement unavailable and MUST fail closed.

## Read-only preparation and final admission

Authorization uses two phases. Implementations MAY combine the phases inside one transaction, but they MUST preserve the same no-mutation and revalidation properties.

```text
PrepareAuthorization(request, assertion?, nostr_proof?, delegation?):
  (D, R_t, operation, resource) := ResolveTargetContext(request) or DENY

  if delegation is present:
      require assertion and assertion-provenance fields are absent
      ValidateNostrProof(nostr_proof, D, R_t) -> k or DENY
      R := SealActor(R_t, k)
      return PrepareDelegated(D, R, k, delegation)

  VerifyTransportProvenance(D, R_t, assertion) or DENY
  ValidateNostrProof(nostr_proof, D, R_t) -> k or DENY
  R := SealActor(R_t, k)
  ValidateAssertion(assertion, D) -> (i, k_a?, deadline, policy_id, g)
  if k_a exists and k_a != k: DENY(key_mismatch)

  atomically read B(i), B(k), retired(i,k), disabled(i),
                      revoked(k), pending(i), mode(D), and policy state

  if disabled(i):                 DENY(identity_disabled)
  if revoked(k):                  DENY(key_revoked)
  if retired(i,k):                DENY(pair_retired)
  if pending(i):                  DENY(explicit_replacement_required)

  if B(i) = B(k) = binding(i,k):
      if binding.binding_not_after exists and
         now >= binding.binding_not_after: DENY(binding_expired)
      proposal := existing(binding.version, binding.provenance)
  else if B(i) exists or B(k) exists:
      DENY(binding_conflict)
  else switch mode(D):
      attested-key:
          require k_a = k
          proposal := enroll(i, k, attested-key)
      provisioned:
          DENY(binding_required)
      tofu:
          proposal := enroll(i, k, k_a = k ? attested-key : tofu)

  EvaluateEveryLocalAdmissionPolicy(D, R, operation, resource, k) or DENY
  return PreparedAuthorization(all evidence, proposal, witnesses, and bounds)
```

An absent `binding_not_after` has no expiry. Assertion `exp`, `iat`, and maximum age never populate or extend it. Enrollment mode controls creation only; changing the mode does not rewrite or downgrade an existing eligible binding or its provenance.

Preparation is read-only, including for Attested and TOFU first use. It creates or changes no binding, lifecycle, enrollment, replay, receipt, audit, observation, publication, last-seen, lease, or application state. A denial has the same no-mutation property.

Final admission consumes the prepared value exactly once:

```text
CommitAdmission(prepared, current_request):
  require exact D, R, operation, resource, actor, and transport match
  require every assertion, proof, proxy, delegation, and policy bound is live
  if prepared is DirectPrepared:
      require CurrentVerifierPolicyIdentity(D, prepared.direct.i.iss) =
              prepared.direct.policy_id
      if CurrentJwksGeneration(prepared.direct.policy_id) !=
         prepared.direct.g:
          revalidate the assertion under the current generation
  else:
      require prepared is DelegatedPrepared
      revalidate its delegation, relationship, owner, target, and policy witnesses

  atomically:
      reread every applicable binding, lifecycle, enrollment-mode, policy, resource,
             replay, and invalidation witness
      unreadable state denies; changed state requires a complete recomputation
      require the current result is equivalent and eligible
      claim every applicable proxy nonce and proof replay identity
      create the proposed binding only if enrollment remains eligible
      append the required receipt and privacy-safe authorization audit evidence

  return CommittedAuthorization(exact actor, binding dependencies,
                                capabilities, dependencies, and deadline)
```

No committed authorization can be constructed directly from raw claims, a prepared value, cached policy, or earlier lease. A final-admission failure rolls back every authority mutation. Complete recomputation may accept only a semantically equivalent current result. If another request concurrently creates the identical eligible binding, this request may therefore recompute as `existing`; a conflicting winner denies. Storage failure or an unreadable committed result never falls back to allow.

The admitted application operation runs only after committed authorization. If the operation cannot share the authorization transaction, the implementation must use a request-bound idempotent receipt or equivalent staging so a retry cannot create a second effect from the same proof.

## Enrollment modes

- **`attested-key`**: first use requires the assertion's key claim to equal the proven key. The created binding records `attested-key` provenance.
- **`provisioned`**: ordinary requests never create a binding. A separately authorized `ProvisionBinding` transition creates it without creating a lease; later direct use still requires a current assertion and fresh proof.
- **`tofu`**: first eligible use may create a binding without a key claim. This accepts the risk that a stolen assertion for a never-enrolled identity can bind an attacker's key. Deployments MUST label and document that risk. When a matching key claim is present, the binding records `attested-key`, not `tofu`.

Binding provenance is immutable and cannot be downgraded by later requests.

## Lifecycle transitions

Provisioning, retirement, disablement, revocation, rotation, recovery, re-enablement, and administrative-expiry changes are explicit privileged transitions, never side effects of ordinary authorization. Privileged authority is bound to the exact domain, operation, identity, old binding version when present, target key when present, and request. Ordinary assertion and Nostr proof cannot substitute for that authority.

Every transition reads and rechecks the active relation and all applicable retired-pair, disabled-identity, revoked-key, and pending-replacement facts in one atomic transition. It appends immutable lifecycle history and triggers dependent lease invalidation after commit. Failure or stale state causes no partial mutation.

- **Provision binding**: allowed only in `provisioned` mode for an eligible identity and key. It creates a fresh binding version with `provisioned` provenance and no lease.
- **Retire pair**: removes the active binding, records its exact pair as retired, and records pending replacement lineage.
- **Disable identity**: records the identity as disabled. If an active binding exists, it retires that exact pair and records pending lineage.
- **Revoke key**: records the key as revoked even if it is not active. If active, it removes the binding, retires the exact pair, and records pending lineage. Repeating the same authorized revocation is idempotent and cannot erase lineage.
- **Rotate**: replaces one exact active old binding with an eligible new key, retires the old pair, and creates a fresh binding version. Rotation does not globally revoke the old key.
- **Recover**: consumes one exact pending-replacement lineage, preserves the retired old pair, and creates a fresh binding version for an eligible new key. A disabled identity uses Re-enable identity instead of Recover.
- **Re-enable identity**: requires the disabled identity and either no prior lineage or one exact pending lineage. It creates an eligible binding, clears the disabled state, and consumes present lineage exactly once.
- **Set administrative expiry**: requires one exact active binding version and sets, replaces, or clears `binding_not_after` under separate privileged policy. It advances the binding version and cannot change the pair or provenance.

Every new target key, including a provisioned key, requires fresh target-bound Nostr proof. When the domain requires issuer attestation for creation or replacement, the transition also requires a current assertion for the same identity with a key claim equal to the target key. Supplied stale, claimless, wrong-identity, or mismatched attestation is rejected; it cannot be treated as absent optional evidence.

An administrative `binding_not_after` is an authorization gate, not an implicit lifecycle transition. At or after the bound, the binding remains durable and occupies both sides of the partial bijection, but it is authorization-ineligible. Time passage alone creates no tombstone, pending lineage, or history. Restoring access requires `SetAdministrativeExpiry` or another applicable privileged lifecycle transition; ordinary authorization cannot renew the bound.

## Delegation

Delegation is a separate evidence path. The delegate presents fresh proof of its own key and no federated assertion. Separately validated delegation evidence seals the owner key, delegate key, relationship identifier and revision, allowed operations and conditions, exact request or target, and mandatory finite expiry.

The service MUST resolve a current authorization-eligible owner binding and exact binding version at preparation and final admission. A cached owner lease is not substitute authority. The delegated operation is the intersection of the sealed delegation and local operation policy. The path creates or changes no owner or delegate binding, lifecycle fact, provenance, or last-seen state.

A delegated lease requires a configured positive finite maximum. Its deadline is no later than every owner-binding, delegation, local-policy, implementation, and optional stronger owner-assertion bound. Missing finite configuration, stale owner state, actor or request mismatch, unsupported capability, unreadable dependency, or expired delegation denies. Owner retirement, disablement, key revocation, binding-version change, or relationship change invalidates dependent leases within the documented detection bound.

## Session semantics

HTTP authorization applies to one exact request. It does not imply a reusable lease.

A WebSocket lease is scoped to one authenticated key, domain, operation set, direct-assertion or delegated-evidence dependencies, current binding and lifecycle versions, policy versions, and invalidation dependencies. A direct lease records its verifier policy identity, JWKS generation, verification-key identity, key-snapshot hard-validity deadline, and confidential revalidation material for the exact assertion. A delegated lease instead records the exact owner binding version and relationship revision.

The deadline is the earliest applicable assertion `exp`, `iat + maximum_assertion_age`, key-snapshot hard-validity deadline, proof or proxy bound, administrative binding expiry, delegation expiry, local-policy limit, and configured finite implementation maximum. Equality is expired.

Assertion expiry ends the lease, not the binding. Renewal requires a new connection carrying a fresh assertion on the upgrade request, followed by fresh NIP-42 proof and a complete new preparation and final admission. If the durable binding remains eligible, expiry of the assertion used for an earlier lease does not prevent the new decision. Exact assertion revalidation material is retained confidentially only through the admission or lease that may need it and is destroyed on expiry, close, or invalidation.

Before each protected use, the service rechecks the binding and lifecycle versions, administrative bound, operation, resource, actor, and lease deadline. A direct lease also requires a live, readable key snapshot within its hard-validity deadline; a changed JWKS generation requires revalidation of the original assertion against the current generation. For a delegated lease, the service rechecks the exact current owner binding and relationship revision. When another dependency changes, the service rejects protected operations or closes the connection within its documented detection bound. A polling implementation cannot claim immediate invalidation. A lease for one key never authorizes an operation attributed to another key on the same connection.

## Rejection semantics

Implementations may retain detailed private decision reasons for audit and conformance, including `key_mismatch`, `binding_conflict`, `pair_retired`, `identity_disabled`, `key_revoked`, `explicit_replacement_required`, and `binding_expired`. Public results map them to four stable, privacy-safe classes:

| Public code | Nostr prefix | HTTP status | Meaning |
|---|---|---:|---|
| `missing_evidence` | `auth-required:` | 401 | Required assertion, proof, or delegation evidence was absent. |
| `evidence_rejected` | `restricted:` | 403 | Presented evidence or transport provenance was rejected. |
| `authorization_denied` | `restricted:` | 403 | Current binding, lifecycle, delegation, or local operation policy denied access. |
| `authorization_unavailable` | `restricted:` | 503 | Required current state could not be verified. |

Responses MUST NOT identify another principal or key, distinguish a conflict from a tombstone, expose issuer or claim details, echo bearer material, or reveal private policy state. An unavailable dependency never becomes an allow.

## Discovery

A relay SHOULD advertise support in its NIP-11 document under `limitation` as `"federated_identity": true`. It MAY include this top-level object:

```json
{
  "federated_identity": {
    "transports": ["trusted-proxy-hmac-v1"],
    "enrollment": "attested-key",
    "delegation": false
  }
}
```

`transports` contains only the exact identifiers `client-attached` and `trusted-proxy-hmac-v1` for profiles implemented completely. `enrollment` is exactly one configured mode. `delegation` is true only when owner-current resolution and a positive finite delegated maximum are configured. Unknown fields are ignored.

A service MUST NOT enter enforcement or advertise support until every configured protected operation uses the same canonical final-admission authority, unknown protected routes fail closed, and all applicable conformance traces pass at one reviewed revision. Discovery is selected by the same server-owned domain policy as authorization. It MUST NOT expose private issuer URLs, audiences, claim names, tenant identifiers, HMAC key identifiers, or implementation-only policy detail.

## Privacy

NIP-FI defines no public identity projection. Protocol events, tags, filters, discovery, errors, logs, metrics, and traces MUST NOT contain raw assertions or unredacted `iss`, `sub`, email, display name, or other private claims. Access-controlled binding, lifecycle, receipt, and audit state may retain the minimum identifiers required for enforcement and investigation.

Any separate presentation protocol is non-authoritative and cannot create, renew, prove, or revoke NIP-FI authorization. Implementations MUST bound metric and log cardinality and use redacted or pseudonymous correlation.

## Security considerations

- **Issuer compromise** can impersonate principals but cannot prove an uncompromised already-bound Nostr key. In `attested-key` mode it must also forge the matching key claim to enroll an arbitrary key.
- **Assertion theft** cannot use an eligible existing binding without the bound key. TOFU intentionally retains first-use theft risk.
- **Proxy spoofing and replay** are limited by request-bound HMAC provenance, bounded time, one-time nonce consumption, exact assertion and body digests, and exact server-resolved routing values.
- **JWKS rotation and rollback** do not change stable policy identity. Final generation revalidation prevents a removed key or stale snapshot from authorizing.
- **Time-of-check/time-of-use races** are limited by read-only preparation and complete witness revalidation in final admission.
- **Lifecycle replay** cannot erase retired-pair, disabled-identity, revoked-key, or pending-replacement facts. Ordinary assertions never reactivate them.
- **Cross-domain and cross-request confusion** are prevented by server-owned context and exact evidence binding.
- **Availability attacks** on issuer, key retrieval, policy, binding, replay, or audit state fail closed. Refresh, replay, and observability work must be bounded.
- **Delegation confusion** is limited by exact owner and delegate keys, owner binding version, relationship revision, capability intersection, target binding, and finite expiry.

## Stable conformance labels

The companion model and later executable matrix use these stable trace identifiers. A conforming implementation must cover every applicable trace and its boundary and concurrency subcases at one reviewed revision. The model also defines the stable safety labels `FI-INV-01` through `FI-INV-16`.

| ID | Required property |
|---|---|
| `FI-TRACE-PROXY-SPOOF` | A valid assertion without valid proxy HMAC provenance, including direct ingress, denies. |
| `FI-TRACE-PROXY-REPLAY` | Two final admissions using one proxy nonce produce at most one committed authorization; preparation consumes neither. |
| `FI-TRACE-PROXY-CROSS-REQUEST` | Changing the assertion, method, authority, path/query, or body invalidates provenance and denies. |
| `FI-TRACE-AUTHORITY-UNIFORM` | Every protected ingress uses the same current domain policy and final-admission authority. |
| `FI-TRACE-VERIFIER-PARITY` | The same assertion, policy, time, and key snapshot produce the same verifier result on every transport. |
| `FI-TRACE-DOMAIN-SPOOF` | Client-selected domain or forwarded authority cannot replace server-owned context. |
| `FI-TRACE-ASSERTION-KEY-MISMATCH` | An asserted key different from the proven key denies before mutation. |
| `FI-TRACE-BINDING-CONFLICT` | A pair that conflicts with either side of the active relation denies without replacement. |
| `FI-TRACE-TOMBSTONE-REPLAY` | Fresh evidence for a retired pair, disabled identity, revoked key, or pending replacement denies ordinary authorization. |
| `FI-TRACE-ASSERTION-REFRESH` | A fresh assertion can authorize the same eligible durable binding after an earlier assertion expires. |
| `FI-TRACE-ADMIN-EXPIRY` | A fresh assertion after administrative expiry denies; only an explicit privileged transition can restore access. |
| `FI-TRACE-JWKS-ADD` | A generation change with the old key retained revalidates and may authorize the unchanged binding. |
| `FI-TRACE-JWKS-REMOVE` | A generation change that removes the signing key denies prepared evidence and leases signed by it. |
| `FI-TRACE-PREPARED-STALE` | Changed request or decision witnesses deny or require a complete recomputation before admission. |
| `FI-TRACE-FINAL-DENIAL-NO-MUTATION` | Preparation, denied local policy, and denied final admission create no binding, audit or denial observation, replay claim, receipt, lease, or application mutation. |
| `FI-TRACE-CONCURRENT-ENROLLMENT` | Identical eligible first uses converge on one binding version; conflicting first uses commit at most one winner. |
| `FI-TRACE-TOFU-THEFT` | Stolen-assertion first use denies except under explicit risk-labelled TOFU. |
| `FI-TRACE-DELEGATE-OWNER-ROTATED` | Owner rotation makes an old-owner delegation non-current and denies without inheritance. |
| `FI-TRACE-DELEGATION-EXPIRED` | Missing or expired finite delegation bounds deny. |
| `FI-TRACE-DENIAL-ORACLE` | Unknown, conflict, tombstone, and private-policy denials are not publicly distinguishable. |
| `FI-TRACE-DEPENDENCY-FAIL-CLOSED` | An unreadable current verifier, key, state, replay, policy, receipt, or audit dependency denies. |
| `FI-TRACE-MULTI-KEY-SESSION` | A lease for one authenticated key does not authorize another key on the same connection. |
| `FI-TRACE-CROSS-DOMAIN-COLLISION` | Equal subjects across issuers or equal pairs across domains remain distinct. |
| `FI-TRACE-PRIVACY-NONPUBLIC` | Assertion or private identity material in protocol output, public history, or observability is a conformance failure. |

The companion [formal model](NIP-FI-MODEL.md) gives the state machine, safety and liveness properties, and the complete form of these traces.
