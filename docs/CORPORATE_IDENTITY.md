# Corporate identity migration

Historical corporate identity approaches based on provider-specific middleware, unsigned forwarded headers, or a parallel authorization authority are retired guidance. Buzz's provider-neutral contract is [NIP-FI](nips/NIP-FI.md).

## Runtime configuration

The relay's protected authorization runtime is configured only with the
`BUZZ_NIP_FI_V1_CONFIG_JSON` environment variable. The former
identity-provider variables (`BUZZ_REQUIRE_CORPORATE_IDENTITY` and every
`BUZZ_CORPORATE_IDENTITY_*` name) are removed: setting any of them fails
startup instead of weakening policy, and none of them is an alias for the
document below.

Configuring the runtime is not conformance. A deployment must pass the
[behavioral evidence matrix](nips/NIP-FI-CONFORMANCE.md) at its exact
deployed revision before NIP-FI discovery or enforcement is advertised, and
operators must verify the effective configuration in their deployment;
public wording alone is not activation or conformance evidence.

### Operating modes

- **Off:** leave `BUZZ_NIP_FI_V1_CONFIG_JSON` unset. Protected composition is
  not installed and existing unprotected behavior remains available.
- **DenyProtected:** set the document to `{"deny_protected":true}`. Every
  protected route is denied before its handler runs. `deny_protected` takes
  precedence over every other field in the document.
- **Enforce:** provide the complete document below. Missing, unknown, empty, or
  invalid fields fail startup.

```json
{
  "issuer": "https://issuer.example",
  "audience": "buzz-relay",
  "subject_claim": "sub",
  "event_author_claim": "nostr_pubkey",
  "clock_skew_seconds": 30,
  "maximum_token_lifetime_seconds": 3600,
  "jwks": {
    "jwks_uri": "https://issuer.example/.well-known/jwks.json"
  },
  "lease": { "maximum_seconds": 300 },
  "policy_revision": 1,
  "audit": {
    "max_events_per_domain": 1000000,
    "max_bytes_per_domain": 4294967296,
    "max_envelope_bytes": 65536
  },
  "client_status_admission": {
    "max_presentations_per_domain": 1000000,
    "max_presentations_per_actor": 10000,
    "max_presentations_per_peer": 10000
  },
  "transport": {
    "kind": "trusted_proxy_hmac_v2",
    "active_secrets_base64url": ["replace-with-base64url-secret"],
    "maximum_provenance_age_seconds": 60,
    "future_skew_seconds": 5
  },
  "enrollment": { "kind": "canonical_admission" },
  "restore": { "kind": "operation_manifest" },
  "delegation": { "enabled": false }
}
```

### Document rules and bounds

The document rejects unknown fields. In Enforce mode:

- `issuer` and `audience` are required non-empty strings of at most 2048
  characters each.
- `subject_claim` defaults to `sub`. It and the optional `event_author_claim`
  are limited to 128 characters.
- `clock_skew_seconds` defaults to `0` and is at most 300.
- `maximum_token_lifetime_seconds` is required, positive, and at most 86400.
- `jwks` accepts exactly one HTTPS `jwks_uri` or `discovery_uri`; credentials,
  fragments, redirects, and private-network targets are rejected.
- `lease.maximum_seconds` is required, positive, and at most 3600.
- `policy_revision` is required and positive.
- `audit` sets the immutable authorization-evidence capacity
  (`max_events_per_domain`, `max_bytes_per_domain`, `max_envelope_bytes`).
  There is no online prune, export, reset, or acknowledgement workflow — size
  the budget for the installation's lifetime with generous headroom, because
  exhaustion denies further authorization-affecting operations instead of
  dropping evidence.
- `client_status_admission` limits are positive;
  `max_presentations_per_domain` cannot exceed `audit.max_events_per_domain`,
  and the per-actor and per-peer limits cannot exceed the per-domain limit.
- `transport`, `enrollment`, and `restore` are required non-empty objects
  consumed by the matching runtime adapters. Production ingress requires the
  exact `trusted_proxy_hmac_v2` transport configuration shown above; the
  trusted-proxy provenance verifier is constructed at startup, before
  listeners open.

The `jwks` refresh policy is validated at construction: a fetched document
cannot exceed 4 MiB, a snapshot cannot stay fresh longer than 24 hours, every
refresh bound is finite and nonzero, and an accepted key set contains between
1 and 128 keys. Production uses tighter bounds. Key refreshes are
single-flight and stale verification fails closed. Current-status
presentation renews within 120 seconds, so active connections observe
authoritative policy changes within that polling bound.

### Delegation

Delegation is disabled by default. Omitting the `delegation` object or setting
`{"enabled": false}` disables it, and a disabled delegation object must not
carry capabilities or a lifetime. Enabling it requires `enabled: true`, a
non-empty unique `capabilities` list drawn from the closed route-capability
set, and a positive `maximum_seconds` of at most 3600 that does not exceed
`lease.maximum_seconds`. Delegated authority is always capability-scoped —
never transport-wide — and the relay's NIP-11 information document does not
advertise delegation.

Corporate-identity delegation is currently unsupported. The public production
path does not implement complete delegated issuance, owner-bound resolution,
expiry, invalidation, reconnect, or protected-transport behavior. Operators
must keep delegation disabled, and discovery must report it as false or omit
it. Enabling the configuration shape does not add the missing authority and
must not be used to advertise support. See the
[integration guide's availability boundary](NIP_FI_INTEGRATION.md#delegation-availability)
for the implementation and evidence requirements.

Direct NIP-FI authorization and future delegation are separate capabilities.
Delegation can be advertised only after a reviewed delegated-owner
implementation passes the complete applicable cross-transport lifecycle and
session evidence.

## Supported boundary

NIP-FI combines a valid issuer assertion with independent fresh Nostr key proof, current durable binding and lifecycle state, server-owned request context, and final application admission. For the trusted-proxy profile, the stock Buzz contract requires cryptographic HMAC provenance bound to the complete canonical request. Header presence and network location alone are insufficient.

NIP-FI defines no public corporate directory or identity projection. Issuer-qualified identity and profile claims remain access-controlled enforcement data.

## No parallel authority

An enforcing domain has one current NIP-FI authority and policy lineage for every protected ingress. Do not:

- accept a legacy corporate header when NIP-FI denies;
- keep a provider-specific identity path for selected routes;
- infer identity from email or subject without the configured issuer;
- copy assertion expiry into durable binding expiry;
- import revoked, disabled, or retired state as an active binding; or
- expose corporate claims in Nostr events, discovery, logs, metrics, or traces.

NIP-42 and NIP-98 continue to prove control of a Nostr key. They do not replace the additional NIP-FI authority for a protected operation.

## Migration plan

1. **Inventory:** enumerate every protected WebSocket and HTTP ingress, existing identity source, forwarded field, policy, binding store, lifecycle action, and fallback.
2. **Freeze legacy expansion:** add no routes, providers, claims, or identities to the legacy authority while migration is in progress.
3. **Define domains and policies:** map each server-owned domain to exact issuer-qualified identities `(iss, sub)`, accepted semantics, enrollment mode, and transport profile.
4. **Normalize state:** represent active durable bindings, immutable provenance, retired pairs, disabled identities, revoked keys, pending replacement lineage, typed history, and versions.
5. **Verify imports:** require independent evidence for imported identity/key pairs. Do not treat a forwarded header, email match, or expired assertion as proof of key control.
6. **Install without activation:** deploy the later exact implementation with discovery and enforcement off, one canonical verifier, and no legacy fallback.
7. **Run behavior:** execute all applicable `FI-TRACE-*` adapters at the exact artifact, deployment, and policy digests, including route inventory and deployed-boundary proxy negatives.
8. **Cut over atomically:** enable one authority across the complete protected-ingress set and remove the legacy path. Canary isolated domains or deployments, not individual routes under competing authorities.
9. **Verify and retain:** test old headers, old keys, tombstones, conflicts, denial privacy, dependency outages, restore, and rollback; retain privacy-safe evidence.

If historical data lacks proof or unambiguous issuer qualification, keep it non-authoritative until a separately authorized provisioning or recovery transition establishes current state.

## Rollback and repair

Rollback returns to a previously conformant artifact with compatible current state, or disables discovery and fails protected operations closed. It never restores unsigned forwarding, a removed verification key, a parallel provider runtime, or an older authority database.

Correct an imported binding or lifecycle fact with a reviewed privileged compensating transition. Preserve typed history and incident evidence; do not delete the record to make ordinary enrollment available again.

## Operator references

- [Integration contract](NIP_FI_INTEGRATION.md)
- [Threat model](NIP_FI_THREAT_MODEL.md)
- [Stock deployment](NIP_FI_DEPLOYMENT.md)
- [Runtime operations](NIP_FI_RUNTIME_OPERATIONS.md)
- [Contributor guide](NIP_FI_CONTRIBUTING.md)
