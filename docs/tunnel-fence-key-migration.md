# Tunnel fence Redis key migration

Tunnel lease and generation keys must share a Redis Cluster hash slot. The
cluster-safe tagged format is deliberately gated by
`BUZZ_TUNNEL_FENCE_KEY_FORMAT`; its default is `legacy` so an ordinary image
rollout cannot activate new-format writers while old writers still run.

## Required two-phase deployment

1. **Drain deploy:** deploy the new binary everywhere with
   `BUZZ_TUNNEL_FENCE_KEY_FORMAT=legacy` (or unset). Keep the existing
   standalone Redis endpoint. Wait until every old binary has terminated and
   its maximum graceful-shutdown/lease window has elapsed. Verify no old pod
   can acquire or renew a legacy lease.
2. **Enable deploy (non-rolling):** scale the relay deployment to zero and wait
   until the maximum graceful-shutdown/lease window has elapsed. Confirm that no
   relay process remains and no legacy lease can still be renewed. Set
   `BUZZ_TUNNEL_FENCE_KEY_FORMAT=tagged` on the whole deployment, move to the
   cluster-enforcing endpoint, and then scale up. Do **not** start the first
   tagged pod while any legacy-mode pod is alive. The first tagged acquisition
   seeds its non-expiring generation from the drained legacy watermark before
   incrementing it. Tagged state is authoritative once initialized.

Do not mix `legacy` and `tagged` writers. The two legacy keys occupy different
cluster slots, so Redis cannot atomically prove that an old writer did not race
the migration.

## Rollback rule

Before phase 2, roll back normally with the format left `legacy`. After any pod
has enabled `tagged`, **do not roll back to an old binary or set the format back
to `legacy`**. Roll back only to a tagged-capable binary with the format still
`tagged`; otherwise a legacy writer can reuse an already-issued generation and
break fencing. Restoring legacy mode requires a full mesh outage, drainage of
all tagged leases, and an operator-reviewed generation migration; it is not a
rolling rollback.
