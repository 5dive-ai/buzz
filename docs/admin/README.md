# Read-only deployment moderation dashboard

Buzz can expose a private, deployment-wide read-only dashboard from the existing
relay process. It shows open moderation reports and recent product feedback.

Configure `BUZZ_ADMIN_HOST` and a strong password to activate the dashboard. A
private ingress should also limit access to the operator VPN or approved source
IPs.

Required configuration:

```text
BUZZ_ADMIN_HOST=admin.example.com
BUZZ_ADMIN_USERNAME=admin
BUZZ_ADMIN_PASSWORD=<random password with at least 16 bytes>
BUZZ_ADMIN_WEB_DIR=/srv/buzz/admin-web
```

The relay requires HTTP Basic credentials before it serves the dashboard, its
assets, any admin API, or an attachment. `BUZZ_ADMIN_USERNAME` defaults to
`admin` and must not contain a colon; the password has no default, must be 16
to 1024 bytes, and is retained by the relay only as a digest. The configured
host and matching browser origin remain defense-in-depth checks. Requests and
responses are bounded and uncached. Use HTTPS so the credentials are not
exposed in transit, and route admin traffic through the private ingress.

If `BUZZ_ADMIN_HOST` is set but the credentials are missing or invalid, the
relay logs an error, disables the dashboard, and continues serving normally —
the admin host then behaves like any other host. The dashboard is an optional
surface, so a missing password costs the dashboard rather than the relay. Check
startup logs for `admin dashboard disabled` after any change to these variables.

When the UI runs in a separate pod, proxy `/api/admin/v1/*` to the relay while
preserving the admin `Host` header. A `NetworkPolicy` grants the admin pod access
to that relay path.

Read routes:

- `GET /api/admin/v1/reports`
- `GET /api/admin/v1/reports/:id`
- `GET /api/admin/v1/feedback`
- `GET /api/admin/v1/feedback/:id`

Report reads accept optional `communityId`, `status`, `reportType`, `targetKind`,
`after`, `before`, and `limit` parameters. Limits are capped at 200. Feedback is
a bounded newest-first summary from the existing product-feedback repository.

For local review, run `just admin-seed` before `just admin`. The seed command
also uploads real image and diagnostic fixtures to local MinIO. Feedback search
and filters run over the bounded browser result set; the **Acted on** checkbox is
stored in that browser's local storage.

## Feedback attachment boundary

Feedback attachment bytes are available only through the feedback-scoped read
route:

- `GET /api/admin/v1/feedback/:id/attachments/:sha256`

The route uses the same private-ingress, exact admin `Host`, and same-origin
boundary as the JSON API. It is not a generic media endpoint. The relay loads
the feedback row, derives its community from server-owned provenance, verifies
that host resolution still maps to the row's `community_id`, and requires the
requested SHA-256 to match both the `x` field and source-community `/media/` URL
in that row's persisted `imeta` tag. It then reads the tenant-scoped media
sidecar before accessing the shared content-addressed blob. Unknown feedback,
unreferenced hashes, malformed paths, and cross-community substitutions all
collapse to `404`.

Only `GET` and `HEAD` are routed. Existing community `/media/*` authorization is
unchanged, including `BUZZ_REQUIRE_MEDIA_GET_AUTH`; the browser receives no
Blossom credential or reusable signed URL. Responses are uncached, `nosniff`,
governed by a restrictive CSP, streamed from object storage, and non-previewable
content retains attachment disposition. Successful reads produce a structured
trace containing feedback ID, community ID, and attachment hash, but no feedback
body or attachment URL.

The deployment credential identifies administrators as a group, not as
individual people. Anyone with that credential can read attachments for
feedback records they can access. Rotate the password when an administrator
loses access. Per-person attribution requires identity-aware authentication at
the ingress or application layer.
