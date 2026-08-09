# Corporate identity migration

Historical corporate identity approaches based on provider-specific middleware, unsigned forwarded headers, or a parallel authorization authority are retired guidance. Buzz's provider-neutral contract is [NIP-FI](nips/NIP-FI.md).

## Current status

This documentation revision does not include a NIP-FI runtime adapter, activate identity enforcement, or establish conformance. Do not deploy a legacy identity sidecar or trust an identity header as a temporary substitute. A later exact-head implementation and deployment must pass the [behavioral evidence matrix](nips/NIP-FI-CONFORMANCE.md) before discovery or enforcement is enabled.

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
