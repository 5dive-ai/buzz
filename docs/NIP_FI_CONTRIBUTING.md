# Contributing to NIP-FI

This guide applies to public NIP-FI protocol, implementation, deployment, and operations changes in Buzz. Repository-wide rules in [CONTRIBUTING.md](../CONTRIBUTING.md) still apply.

## Start with the contract

Read these together:

1. [NIP-FI](nips/NIP-FI.md) defines normative behavior.
2. [The formal model](nips/NIP-FI-MODEL.md) defines state, invariants, and transitions.
3. [The conformance evidence matrix](nips/NIP-FI-CONFORMANCE.md) defines the behavioral release gate.
4. [The threat model](NIP_FI_THREAT_MODEL.md) records assets, trust boundaries, and residual risk.

Non-normative implementation or operator prose cannot weaken those documents.

## Change ownership

Keep changes in the layer that owns them:

- normative semantics belong in the specification and model;
- stable behavioral oracles belong in the conformance matrix;
- runtime adapters, state, routes, and tests belong in the implementation stack;
- network isolation and secret delivery belong in deployment artifacts;
- lifecycle procedures and evidence retention belong in operations guidance; and
- public entry points link to accepted behavior without claiming unexecuted support.

Do not move later runtime behavior into an earlier reviewed commit to make a checklist appear complete. Preserve protected ancestry and append reviewable, signed-off commits.

## Stable labels

`FI-INV-01` through `FI-INV-16` and the 24 `FI-TRACE-*` identifiers are public review interfaces. Do not renumber or reuse them for different semantics.

When behavior changes:

1. update the normative text and model together;
2. decide whether an existing trace still represents the same oracle;
3. add a new stable trace only when no existing trace can express the behavior;
4. update the matrix and example report in the same series; and
5. hand the label to the implementation stack for executable adapter coverage.

A wording cleanup that does not change behavior should not churn labels.

## Behavioral adapters

An adapter maps a stable trace to executable behavior at one exact implementation revision. It records the command, test IDs, fixtures, expected oracle, artifacts, and cleanup.

Adapters should exercise production or production-equivalent entry points. Internal helpers may inspect state or inject an outage. They cannot replace the protected operation under test.

Examples:

- verifier parity runs one assertion corpus through every transport adapter;
- uniform authority executes the protected-route inventory and observes policy identity at each ingress;
- tombstone replay creates selector state in the database, presents fresh evidence through a real ingress, and verifies no mutation;
- final-denial tests inspect replay, receipt, binding, audit, and application stores; and
- trusted-proxy spoof tests run against the deployed listener boundary.

The following are not behavioral adapters:

- a regular expression over source or generated schemas;
- a test that checks only that a function or route exists;
- a documentation-link check;
- a mocked proxy-isolation test; or
- a passing result copied from another revision.

## Pull request evidence

A runtime or deployment change includes:

- exact parent and head revisions;
- owned behavior and affected stable labels;
- implementation and adapter commands;
- services, fixtures, and fault injection used;
- evidence artifact digests;
- migrations and rollback behavior when state changes;
- route and discovery impact;
- privacy and observability impact; and
- explicit unsupported behavior.

Do not describe a feature as conforming because it compiles, parses configuration, or has a green source-string test. State whether the full exact-head matrix ran and link its immutable report.

## Review checklist

### Protocol and model

- Definitions, pseudocode, state, and traces agree.
- Stable policy identity excludes rotating key material.
- Assertion expiry bounds authority but not durable binding lifetime.
- Lifecycle selectors are checked before ordinary enrollment.
- Preparation remains read-only.
- Final admission rereads only applicable direct or delegated witnesses.
- Public denials remain many-to-one and privacy safe.

### Runtime

- Every protected ingress uses one current authority and policy lineage.
- The canonical verifier produces identical decisions across transports.
- HMAC provenance covers the exact canonical request and retains replay state long enough.
- Binding and lifecycle decisions are serialized under concurrency.
- JWKS addition, removal, hard expiry, and outage behavior are exercised.
- Lease reuse checks current dependencies.
- Application denial leaves no authority or application mutation.

### Lifecycle

- Provisioning requires target-key proof.
- Retirement, disablement, and revocation preserve lineage.
- Rotation starts from one exact active binding and leaves no pending replacement.
- Recovery consumes one exact pending lineage for an enabled identity.
- Re-enablement handles disabled identities and consumes present lineage once.
- Administrative expiry does not create a tombstone or free coordinates.
- Rollback uses a compensating privileged transition instead of database rewind.

### Deployment and operations

- Direct origin access to trusted-proxy ingress is blocked and tested.
- Secret references contain no secret values in repository files.
- Startup denies uncovered routes or competing authorities.
- Backup and restore include lifecycle selectors, policy generations, receipts, and audit state.
- Dependency outages and audit-capacity limits fail closed and alert.
- A rollback cannot restore a removed verification key or bypass current tombstones.

### Evidence

- All 24 traces appear exactly once in the report.
- Every required trace passes at the claim tuple.
- Every `not-applicable` trace has executable absence evidence.
- Artifacts and digests resolve.
- Privacy canaries are absent from every public and operational sink.

## Documentation checks

Documentation-only changes run, at minimum:

```sh
git diff --check
jq empty docs/examples/nip-fi-*.json.example
```

They also validate local Markdown links, code fences, table structure, example-to-normative label equality, and matrix-to-normative label equality. These checks validate documentation consistency. They do not prove runtime conformance.

Runtime and deployment changes additionally run the repository's normal gates and every applicable exact-head behavioral adapter.

## Security-sensitive changes

Treat verifier rules, proxy canonicalization, secret rotation, replay retention, lifecycle transitions, privacy filters, denial mapping, delegation, lease invalidation, restore, and rollback as security-sensitive. Update the [threat model](NIP_FI_THREAT_MODEL.md) when a trust boundary, asset, attacker capability, or residual risk changes.

Never place real assertions, subjects, issuer-private values, HMAC secrets, operator credentials, or production evidence in examples or test fixtures.

## Commit and handoff

Use focused conventional commits with DCO sign-off. Preserve human-authored history and public review text. Before handoff, report exact commit, tree, and parent identities; changed paths; checks; stable labels affected; and remaining implementation or deployment dependencies.
