# NIP-FI integration contract

This guide describes how a Buzz implementation integrates the normative [NIP-FI specification](nips/NIP-FI.md), [formal model](nips/NIP-FI-MODEL.md), and [behavioral evidence matrix](nips/NIP-FI-CONFORMANCE.md). It is non-normative and does not weaken those documents.

## Current status

This documentation revision does not add a runtime adapter, activate enforcement, or establish conformance. A later implementation stack must supply exact-head behavioral adapters for all applicable `FI-TRACE-*` identifiers. NIP-FI discovery and enforcement remain off until one immutable implementation and deployment tuple passes the release gate.

Source review, type presence, configuration parsing, route registration, and prose checks are useful review inputs. None proves runtime behavior.

### Delegation availability

NIP-FI delegation is an optional protocol capability, not an implied Buzz
feature. The current public production path has no reviewed delegated-owner
implementation and MUST NOT advertise delegation. Discovery reports
`"delegation": false` or omits the field, and operators keep delegation
disabled. A downstream or legacy configuration switch cannot create the
missing issuance, owner-resolution, expiry, invalidation, reconnect, and
protected-transport behavior.

This documentation-only revision does not change runtime code or configuration
defaults. Operators must verify the effective setting in their deployment;
public wording alone is not evidence that the runtime or its defaults satisfy
this boundary.

The specification, model, sealed types, and conformance vectors may describe
future delegation work without claiming that a route is live. Support can be
advertised only after one reviewed implementation supplies the separate
delegated-owner capability and passes every applicable delegation and session
trace across every advertised transport. Until then, any partially wired
delegation-shaped request must fail closed.

## Integration boundary

NIP-FI is an additional admission authority above NIP-42 or NIP-98 proof of key control. It does not replace Nostr signatures or application authorization. A protected operation proceeds only when all applicable gates agree:

```text
trusted route and domain
  + accepted assertion transport or delegated evidence
  + fresh Nostr proof
  + current binding and lifecycle state
  + current verifier, policy, and resource state
  + final application admission
  = committed authorization
```

A configured deployment uses one canonical current NIP-FI authority for every protected ingress in a domain. It cannot run a legacy identity authority beside NIP-FI, select an older policy lineage for one route, or leave a protected route Nostr-only.

## Protected-ingress inventory

The implementation stack owns an executable inventory of every protected operation. At minimum, reviewers classify and exercise:

- WebSocket connection authentication and each protected message or event path;
- HTTP event submission, query, and count operations;
- media reads, writes, and metadata operations;
- Git smart HTTP and policy hooks;
- audio and real-time session operations;
- invite and moderation operations; and
- lifecycle or operator operations.

The inventory records the server-selected domain, operation, resource, transport profile, policy identity, and final-admission adapter for each route. Unknown protected routes and incompatible policy lineages fail closed. `FI-TRACE-AUTHORITY-UNIFORM` executes the inventory rather than inspecting route source.

## Server-owned context

Trusted listener and route configuration resolves the target context before identity evidence can influence a decision. The Nostr proof then seals the actor key into the request context.

The implementation must not accept a client domain, forwarded authority, assertion claim, tag, or query parameter as a domain selector. If a trusted edge rewrites authority or path, it completes the rewrite before computing HMAC provenance and the relay reconstructs the same canonical post-routing values.

Multi-domain deployments use the same authenticated domain lookup for authorization and discovery. An unconfigured domain receives no inherited NIP-FI profile.

## Canonical assertion verifier

Every transport adapter calls one provider-neutral assertion verifier contract. The verifier owns compact-JWS parsing, issuer and audience selection, algorithm and key compatibility, subject rules, optional key attestation, time bounds, size bounds, JWKS refresh, and normalized evidence.

The stable verifier policy identity contains accepted semantics but excludes rotating keys and transport. A separate JWKS generation identifies the effective key snapshot. Prepared and direct-lease evidence retains a confidential handle to the exact assertion and the key snapshot's hard-validity deadline.

On a generation change, final admission and lease reuse revalidate the original assertion against the current snapshot. A retained key can continue to authorize. A removed key, unreadable current snapshot, or hard-expired snapshot denies. `FI-TRACE-VERIFIER-PARITY`, `FI-TRACE-JWKS-ADD`, and `FI-TRACE-JWKS-REMOVE` prove these behaviors through every transport.

## Assertion transport

The selected profile is part of trusted target context. The implementation supports only complete profiles and never falls back after mixed, missing, or rejected evidence.

### Client attached

The `client-attached` adapter accepts exactly one `Nostr-Federated-Identity: Bearer <JWT>` field and rejects assertion-provenance fields. The same assertion field is used for WebSocket upgrades and HTTP requests. `Authorization` remains reserved for Nostr proof where required and never carries the federated assertion. HTTP evidence and NIP-98 proof arrive on the same request. WebSocket assertion evidence arrives on the authenticated upgrade and is retained confidentially only for the resulting admission or lease.

### Trusted proxy

The `trusted-proxy-hmac-v1` adapter implements the exact envelope, canonical request bytes, time bounds, nonce size, HMAC, and replay retention in NIP-FI. The trusted edge removes inbound assertion and provenance fields before setting its own.

The deployment also proves:

- untrusted clients cannot reach verifier ingress;
- direct origin requests deny;
- mixed profiles deny without fallback;
- client header injection denies;
- nonce replay commits at most once; and
- changing any request-bound field denies.

Local unit tests cannot prove network isolation. The deployment bundle must retain live negative evidence for `FI-TRACE-PROXY-SPOOF`.

## Binding and lifecycle state

Storage represents the formal model's effective state:

- `B`: active durable bindings and immutable provenance;
- `T`: retired exact identity/key pairs;
- `X`: disabled identities;
- `Y`: domain-scoped revoked keys;
- `Q`: pending-replacement lineage;
- `H`: immutable typed lifecycle history; and
- `V`: monotonic binding and lifecycle versions.

An implementation may use different names or tables, but the behavioral selectors remain distinct. A history timestamp is not an active selector. Assertion expiry never becomes binding expiry. Optional administrative expiry is separately authorized and versioned.

Hot-path authorization reads both sides of the active relation and every applicable selector. It does not rely only on writer invariants. Unreadable or contradictory state denies.

## Prepared and committed authorization

Preparation is read-only. It creates no binding, lifecycle fact, replay claim, receipt, audit observation, lease, publication, last-seen value, or application mutation.

Prepared evidence uses one of two dependency sets:

- `DirectPrepared`: assertion, optional proxy provenance, actor binding and lifecycle witnesses, and enrollment-mode witness; or
- `DelegatedPrepared`: delegation, current owner binding and lifecycle witnesses, and relationship witness.

Both include exact request context, fresh Nostr proof, local policy and resource witnesses, deadlines, and invalidation dependencies.

Final admission rereads only applicable witnesses inside the authorization transaction. Unreadable state denies. Changed state requires a complete recomputation and may commit only a semantically equivalent current result. Identical concurrent enrollment may converge on the same binding version; a conflicting result denies.

Replay claims, eligible enrollment, request-bound receipt, and required authorization audit evidence commit together. If the application effect uses another transaction, it consumes a request-bound idempotent receipt so retry cannot duplicate the effect.

## Enrollment modes

- `attested-key` creates a first binding only when the assertion's key claim equals the proven key.
- `provisioned` never creates a binding from ordinary authorization. A privileged transition still requires fresh target-key proof and any configured issuer attestation.
- `tofu` is risk-labelled. It may bind an attacker's key when the attacker has a stolen assertion for a never-enrolled identity.

Mode changes affect future creation only. They do not rewrite existing bindings or downgrade provenance. A matching key claim in TOFU records `attested-key`, not `tofu`.

## Lifecycle operations

Provision, retire, disable, revoke, rotate, recover, re-enable, and administrative-expiry changes are separately authorized transitions. Each binds authority to the domain, operation, request, identity, old version when present, and target key when present.

Every new target key proves control. Replacement provenance reflects the evidence used for that key. A privileged transition without matching issuer key attestation records provisioned provenance; it never inherits TOFU or attested provenance from another key.

Rotation starts from an active binding and leaves no pending lineage. Recovery consumes exact pending lineage for an enabled identity. A disabled identity uses re-enablement. Retired pairs and revoked keys remain durable.

See [runtime operations](NIP_FI_RUNTIME_OPERATIONS.md) for preconditions, postconditions, recovery, and rollback rules.

## Sessions and delegation

HTTP authorization applies to one request. A WebSocket lease is per key, domain, capability, resource, and exact dependency set. Its deadline is the earliest applicable assertion, key-snapshot, proxy, proof, binding, delegation, policy, and implementation bound.

This section defines the contract for future delegation support; the current
[delegation availability](#delegation-availability) statement remains
controlling for Buzz deployments.

Direct lease reuse rechecks current binding and lifecycle versions, the key-snapshot hard deadline, and JWKS generation. Delegated lease reuse rechecks the current exact owner binding and relationship revision. A lease for one key never covers another key on the connection.

Delegation is optional and separate from federated assertion transport. The delegate supplies its own fresh Nostr proof and no assertion or assertion-provenance field. The owner must remain current and eligible at preparation and final admission. Rotation does not transfer delegation to the new owner key.

## Discovery and privacy

Discovery is a claim, not a feature flag. The service advertises only profiles and optional behavior that passed the evidence matrix at the running implementation and deployment revision. An implementation without a complete adapter omits NIP-FI discovery.

NIP-FI defines no public identity projection. Assertions, issuer-qualified identities, profile claims, HMAC correlation values, and private policy state stay out of protocol output and public history. Access-controlled enforcement state retains only what lifecycle, audit, and incident response need.

Public denials use the stable classes from NIP-FI. They do not reveal whether an identity, key, binding, tombstone, claim, enrollment mode, or private policy exists.

## Implementation-stack handoff

The later implementation stack must deliver, at one exact head:

1. a route adapter manifest for every protected ingress;
2. one canonical assertion verifier and transport-neutral assertion corpus;
3. serialized lifecycle storage with selector-conflict fixtures;
4. read-only preparation and atomic final admission;
5. direct and delegated lease dependency revalidation;
6. deployed trusted-proxy negative evidence when that profile is supported;
7. an executable adapter mapping for all applicable `FI-TRACE-*` labels; and
8. a conformance report whose revisions and artifact digests match the deployment.

The implementation handoff also lists exact commands, required services, fault-injection controls, and cleanup steps. A source grep, documentation link, or claim that code paths are wired is not a substitute.

## Related guidance

- [Threat model](NIP_FI_THREAT_MODEL.md)
- [Stock deployment](NIP_FI_DEPLOYMENT.md)
- [Runtime operations](NIP_FI_RUNTIME_OPERATIONS.md)
- [Contributor guide](NIP_FI_CONTRIBUTING.md)
- [Legacy corporate identity migration](CORPORATE_IDENTITY.md)
