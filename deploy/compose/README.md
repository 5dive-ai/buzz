# Buzz Docker Compose deployment

This is the single-node/VPS deployment bundle. It is intentionally separate from
the root `docker-compose.yml`, which remains local development infrastructure.

## Quick start

```bash
cd deploy/compose
cp .env.example .env
$EDITOR .env       # replace every CHANGE_ME value
./run.sh start
```

For a public VPS with automatic Let's Encrypt certificates:

```bash
cd deploy/compose
BUZZ_COMPOSE_TLS=true ./run.sh start
```

The bootstrap script should eventually replace manual `.env` editing for normal
users. It is responsible for generating stable secrets and, optionally, an owner
keypair.

## Production notes

- Requires Docker Compose v2.24.4 or newer; the TLS override uses Compose's
  `!reset` tag to remove the direct relay port when Caddy terminates HTTPS.
- Default `BUZZ_IMAGE` tracks `ghcr.io/block/buzz:main` for early testing. Pin it to `ghcr.io/block/buzz:sha-<7>` or a semver release tag for production once available.
- Keep `BUZZ_RELAY_PRIVATE_KEY`, `BUZZ_GIT_HOOK_HMAC_SECRET`, database/Redis,
  and S3 secrets stable across restarts.
- `RELAY_OWNER_PUBKEY` is intentionally not prefixed with `BUZZ_`; it must be a
  64-character hex Nostr pubkey when closed relay mode is enabled.
- `BUZZ_AUTO_MIGRATE` is opt-in. Set `BUZZ_AUTO_MIGRATE=true` or run
  `buzz-admin migrate` before starting the relay when bootstrapping a fresh
  database. Auto-migration requires an image that includes embedded SQLx
  migrations.
- PostgreSQL must allow the `pgcrypto` extension — schema bootstrap and
  migrations run `CREATE EXTENSION IF NOT EXISTS pgcrypto` (used for
  `gen_random_uuid()` and digest hashing). On managed PostgreSQL, ensure the
  extension is permitted for the migration role or pre-create it as an
  administrator.
- Relay-verified identity (optional, off by default) is configured with
  `BUZZ_NIP_FI_V1_CONFIG_JSON` (see the
  [identity configuration contract](../../docs/CORPORATE_IDENTITY.md)). Its
  `audit` bounds are a one-way lifetime budget per community domain — size
  `max_events_per_domain` from expected identities × lifecycle operations with
  generous headroom and monitor consumption, because exhaustion fails closed
  and denies authorization-affecting operations rather than dropping evidence.
- The stack uses Postgres, Redis, MinIO, and a git data volume because
  those are real Buzz dependencies today. Minimal mode can simplify this later.

Run `./run.sh backup-hint` for the backup checklist.

## NIP-FI readiness

This Compose bundle does not provision a NIP-FI trusted edge, issuer
integration, or conformance runner. The relay's identity configuration
document (`BUZZ_NIP_FI_V1_CONFIG_JSON`, see the
[identity configuration contract](../../docs/CORPORATE_IDENTITY.md)) passes
through like any other relay environment variable, but do not advertise or
enforce NIP-FI from this bundle, and do not add a provider-specific sidecar
or unsigned corporate identity header as a substitute.

An activating deployment must pin an exact image, isolate verifier ingress
when `trusted-proxy-hmac-v1` is enabled, deliver HMAC secrets through a
secret store rather than `.env`, and pass the complete exact-head behavioral
matrix before activation. A valid Compose render or healthy relay does not
close those gates. See the
[provider-neutral deployment guide](../../docs/NIP_FI_DEPLOYMENT.md) and
[runtime operations guide](../../docs/NIP_FI_RUNTIME_OPERATIONS.md).

## Validation

Before sharing an install link publicly, verify a fresh install with:

```bash
cd deploy/compose
cp .env.example .env
$EDITOR .env
./run.sh config
./run.sh start
curl -fsS "http://127.0.0.1:$(grep -E '^BUZZ_HTTP_PORT=' .env | cut -d= -f2-)/_liveness"
./run.sh status
```
