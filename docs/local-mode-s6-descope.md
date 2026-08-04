# Local-mode v1 S6 decision record

**Decision:** The following five groups, comprising the 34 methods marked
`unsupported` in [`crates/buzz-db/SQLITE_BACKEND_INVENTORY.md`](../crates/buzz-db/SQLITE_BACKEND_INVENTORY.md),
are out of scope for local-mode v1:

1. Push delivery persistence (14 methods)
2. Usage analytics (10 methods)
3. Community lifecycle management (5 methods)
4. Relay membership maintenance (3 methods)
5. PostgreSQL operational infrastructure (2 methods)

Local mode supports **one local community per device** in v1. Community
provisioning, archival, owner listing, availability lookup, and ownership
transfer therefore remain production-only capabilities.

This decision was approved by Logan on 2026-08-04 in the S6 discussion. The
implementation must retain PostgreSQL behavior, prevent single-node routes and
handlers from reaching `DbError::UnsupportedBackend`, and document the local
error surface. It does not remove the PostgreSQL implementations.

The S4 SQLite test-classification rationale remains in
[`crates/buzz-relay/SQLITE_HANDLER_TEST_SKIPS.md`](../crates/buzz-relay/SQLITE_HANDLER_TEST_SKIPS.md).
