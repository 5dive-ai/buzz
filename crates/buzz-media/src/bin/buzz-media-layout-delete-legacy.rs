//! Delete verified legacy media payloads after migration reconciliation.

use std::{collections::BTreeSet, env};

use anyhow::{Context, Result};
use buzz_media::migration::{objects_for_sidecar, parse_sidecar_key, RequestPacer};
use buzz_media::MediaStorage;
use clap::Parser;

mod media_layout_common;
use media_layout_common::{verify_destination, CommonArgs};

const CONFIRMATION: &str = "delete-verified-legacy-media";

#[derive(Debug, Parser)]
#[command(name = "buzz-media-layout-delete-legacy")]
struct Args {
    #[command(flatten)]
    common: CommonArgs,
    /// Rejected for destructive cleanup because partial scans can strand shared legacy CAS keys.
    #[arg(long, env = "BUZZ_MEDIA_MIGRATION_START_AFTER")]
    start_after: Option<String>,
    /// Preview is the safe default. Set false only after reconciliation.
    #[arg(long, env = "BUZZ_MEDIA_MIGRATION_DRY_RUN", default_value_t = true, action = clap::ArgAction::Set)]
    dry_run: bool,
    /// Required with --dry-run=false to guard accidental destructive Jobs.
    #[arg(long, env = "BUZZ_MEDIA_DELETE_CONFIRM")]
    confirm: Option<String>,
}

/// Scan all selected sidecars before deleting anything. This two-pass design is
/// important because one flat legacy CAS key can serve multiple communities:
/// every community destination must be byte-verified while the shared source is
/// still present before the shared source is removed.
async fn verify_selected_destinations(
    storage: &MediaStorage,
    common: &CommonArgs,
    pacer: &mut RequestPacer,
) -> Result<(u64, BTreeSet<String>, Option<String>)> {
    let mut continuation = None;
    let mut verified = 0_u64;
    let mut verified_legacy_keys = BTreeSet::new();
    let mut checkpoint = None;
    loop {
        pacer.wait().await;
        let page = storage
            .list_prefix_page("_meta/", continuation.take(), None, common.page_size)
            .await
            .context("list media sidecars")?;
        for (sidecar_key, _) in page.objects {
            let Some((community, sha)) = parse_sidecar_key(&sidecar_key) else {
                tracing::warn!(key = %sidecar_key, "skipping malformed sidecar key");
                continue;
            };
            pacer.wait().await;
            let bytes = storage
                .get(&sidecar_key)
                .await
                .context("read media sidecar")?;
            let meta = serde_json::from_slice(&bytes).context("parse media sidecar")?;
            for object in objects_for_sidecar(community, sha, &meta)? {
                if !verify_destination(storage, pacer, &object).await? {
                    anyhow::bail!(
                        "refusing deletion: sharded destination bytes do not match legacy source: {} (checkpoint: {sidecar_key})",
                        object.sharded
                    );
                }
                verified += 1;
                verified_legacy_keys.insert(object.legacy);
            }
            checkpoint = Some(sidecar_key);
        }
        if !page.is_truncated {
            break;
        }
        continuation = page.next_continuation_token;
        if continuation.is_none() {
            anyhow::bail!("truncated S3 listing returned no continuation token");
        }
    }
    Ok((verified, verified_legacy_keys, checkpoint))
}

async fn delete_verified_legacy_objects(
    storage: &MediaStorage,
    pacer: &mut RequestPacer,
    verified_legacy_keys: BTreeSet<String>,
    dry_run: bool,
) -> Result<(u64, u64)> {
    let mut changed = 0_u64;
    let mut skipped = 0_u64;
    for legacy_key in verified_legacy_keys {
        if dry_run {
            tracing::info!(key = %legacy_key, "would delete verified legacy object");
            continue;
        }
        pacer.wait().await;
        if !storage.head(&legacy_key).await? {
            skipped += 1;
            continue;
        }
        pacer.wait().await;
        storage.delete(&legacy_key).await?;
        changed += 1;
    }
    Ok((changed, skipped))
}

fn ensure_no_start_after(start_after: Option<&str>, env_start_after_is_set: bool) -> Result<()> {
    if start_after.is_some() {
        anyhow::bail!(
            "--start-after/BUZZ_MEDIA_MIGRATION_START_AFTER is unsafe for legacy deletion; rerun from the beginning instead"
        );
    }
    if env_start_after_is_set {
        anyhow::bail!(
            "BUZZ_MEDIA_MIGRATION_START_AFTER is unsafe for legacy deletion; rerun from the beginning instead"
        );
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_target(false).init();
    let args = Args::parse();
    ensure_no_start_after(
        args.start_after.as_deref(),
        env::var_os("BUZZ_MEDIA_MIGRATION_START_AFTER").is_some(),
    )?;
    if !args.dry_run && args.confirm.as_deref() != Some(CONFIRMATION) {
        anyhow::bail!("destructive mode requires --confirm={CONFIRMATION}");
    }
    let storage = args.common.storage()?;
    let mut pacer = RequestPacer::new(args.common.requests_per_second);
    let (verified, verified_legacy_keys, verified_checkpoint) =
        verify_selected_destinations(&storage, &args.common, &mut pacer).await?;
    tracing::info!(verified, checkpoint = ?verified_checkpoint, "all selected sharded destinations match legacy sources; beginning deletion pass");
    let (deleted, skipped) =
        delete_verified_legacy_objects(&storage, &mut pacer, verified_legacy_keys, args.dry_run)
            .await?;
    tracing::info!(deleted, skipped, dry_run = args.dry_run, checkpoint = ?verified_checkpoint, "legacy deletion complete");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ensure_no_start_after;

    #[test]
    fn rejects_start_after_flag() {
        let error = ensure_no_start_after(Some("_meta/community/sha.json"), false)
            .expect_err("start-after must be unsafe for legacy deletion");

        assert!(error.to_string().contains("unsafe for legacy deletion"));
    }

    #[test]
    fn rejects_start_after_env() {
        let error = ensure_no_start_after(None, true)
            .expect_err("start-after env must be unsafe for legacy deletion");

        assert!(error.to_string().contains("unsafe for legacy deletion"));
    }

    #[test]
    fn allows_full_bucket_scan() {
        ensure_no_start_after(None, false).expect("full scan must be allowed");
    }
}
