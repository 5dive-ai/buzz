# SQLite backend inventory

Generated from `#[sqlite_backend(...)]` declarations in `crates/buzz-db/src/lib.rs`.

The 34 unsupported methods are deliberately out of local-mode v1 scope under
[the approved S6 decision record](../../docs/local-mode-s6-descope.md)
(Logan, 2026-08-04), rather than accidental SQLite gaps. Relay route and
handler guards preserve the S4 skip-list justification chain in
[`buzz-relay/SQLITE_HANDLER_TEST_SKIPS.md`](../buzz-relay/SQLITE_HANDLER_TEST_SKIPS.md).

> **Generator note:** keep this decision cross-link when regenerating the table
> below with `cargo test -p buzz-db backend_inventory_is_current -- --nocapture`.

Regenerate after changing declarations with:

```sh
cargo test -p buzz-db backend_inventory_is_current -- --nocapture
```

| Method | SQLite status | Reason |
| --- | --- | --- |
| `accept_push_lease_event` | unsupported | push delivery persistence is PostgreSQL-only |
| `active_push_match_leases` | unsupported | push delivery persistence is PostgreSQL-only |
| `archive_community_owned_by` | unsupported | community lifecycle management is PostgreSQL-only |
| `backfill_from_allowlist` | unsupported | relay membership maintenance is PostgreSQL-only |
| `begin_transaction` | unsupported | requires PostgreSQL operational infrastructure |
| `claim_due_push_match_batch` | unsupported | push delivery persistence is PostgreSQL-only |
| `claim_due_push_wakes` | unsupported | push delivery persistence is PostgreSQL-only |
| `complete_push_match_batch` | unsupported | push delivery persistence is PostgreSQL-only |
| `complete_push_wake` | unsupported | push delivery persistence is PostgreSQL-only |
| `create_community_with_owner` | unsupported | community lifecycle management is PostgreSQL-only |
| `disable_push_endpoint` | unsupported | push delivery persistence is PostgreSQL-only |
| `enqueue_push_wake` | unsupported | push delivery persistence is PostgreSQL-only |
| `enqueue_push_wakes` | unsupported | push delivery persistence is PostgreSQL-only |
| `fail_push_wake` | unsupported | push delivery persistence is PostgreSQL-only |
| `list_communities_owned_by` | unsupported | community lifecycle management is PostgreSQL-only |
| `lookup_community_by_host_for_management` | unsupported | community lifecycle management is PostgreSQL-only |
| `publish_nip43_membership_locked` | unsupported | relay membership maintenance is PostgreSQL-only |
| `reap_exhausted_push_matches` | unsupported | push delivery persistence is PostgreSQL-only |
| `retry_push_match_batch` | unsupported | push delivery persistence is PostgreSQL-only |
| `retry_push_wake` | unsupported | push delivery persistence is PostgreSQL-only |
| `revalidate_push_wake` | unsupported | push delivery persistence is PostgreSQL-only |
| `transfer_ownership` | unsupported | relay membership maintenance is PostgreSQL-only |
| `try_lock_usage_metrics` | unsupported | requires PostgreSQL operational infrastructure |
| `unarchive_community_owned_by` | unsupported | community lifecycle management is PostgreSQL-only |
| `usage_active_channel_counts` | unsupported | usage analytics is PostgreSQL-only |
| `usage_active_user_counts` | unsupported | usage analytics is PostgreSQL-only |
| `usage_channel_counts` | unsupported | usage analytics is PostgreSQL-only |
| `usage_community_count` | unsupported | usage analytics is PostgreSQL-only |
| `usage_community_hosts` | unsupported | usage analytics is PostgreSQL-only |
| `usage_git_repo_counts` | unsupported | usage analytics is PostgreSQL-only |
| `usage_message_counts` | unsupported | usage analytics is PostgreSQL-only |
| `usage_relay_member_counts` | unsupported | usage analytics is PostgreSQL-only |
| `usage_user_counts` | unsupported | usage analytics is PostgreSQL-only |
| `usage_workflow_counts` | unsupported | usage analytics is PostgreSQL-only |
