use super::MIGRATOR;

use crate::identity_binding::{
    get_active_identity_binding_by_pubkey, resolve_identity_binding, BindingDenial,
    BindingProvenance, EnrollmentMode, ResolveBindingInput, ResolveBindingResult,
};
use crate::identity_lifecycle::{
    disable_identity_principal, enable_identity_principal, provision_identity_binding,
    recover_identity_binding, retire_identity_pair, revoke_identity_key, rotate_identity_binding,
    IdentityPrincipal, LifecycleContext, PendingLineage, VerifiedReplacementKey,
};
use buzz_core::CommunityId;
use sqlx::{Acquire, PgPool};
use uuid::Uuid;

const TEST_DB_URL: &str = "postgres://buzz:buzz_dev@localhost:5432/buzz";

async fn connect_pool() -> PgPool {
    let database_url = std::env::var("BUZZ_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .unwrap_or_else(|_| TEST_DB_URL.to_owned());
    PgPool::connect(&database_url)
        .await
        .expect("connect deterministic migration DB")
}

async fn reset_to_0028(pool: &PgPool) -> (Uuid, Uuid) {
    sqlx::query("DROP SCHEMA IF EXISTS public CASCADE")
        .execute(pool)
        .await
        .expect("drop public schema");
    sqlx::query("CREATE SCHEMA public")
        .execute(pool)
        .await
        .expect("create public schema");
    MIGRATOR
        .run_to(28, pool)
        .await
        .expect("migrate through 0028");
    let domain_a = Uuid::new_v4();
    let domain_b = Uuid::new_v4();
    for (domain, label, key) in [
        (domain_a, "migration-fault-a", vec![71_u8; 32]),
        (domain_b, "migration-fault-b", vec![72_u8; 32]),
    ] {
        sqlx::query("INSERT INTO communities (id,host) VALUES ($1,$2)")
            .bind(domain)
            .bind(format!("{label}-{}.example", domain.simple()))
            .execute(pool)
            .await
            .expect("insert migration fault domain");
        sqlx::query(
            "INSERT INTO identity_bindings (community_id,issuer,uid,pubkey,source) \
             VALUES ($1,'https://idp.example',$2,$3,'db_binding')",
        )
        .bind(domain)
        .bind(format!("{label}-subject"))
        .bind(key)
        .execute(pool)
        .await
        .expect("insert migration fault binding");
    }
    (domain_a, domain_b)
}

fn split_statements(sql: &str) -> Vec<String> {
    let bytes = sql.as_bytes();
    let mut statements = Vec::new();
    let mut start = 0;
    let mut index = 0;
    let mut single_quote = false;
    let mut line_comment = false;
    while index < bytes.len() {
        if line_comment {
            if bytes[index] == b'\n' {
                line_comment = false;
            }
            index += 1;
            continue;
        }
        if !single_quote && index + 1 < bytes.len() && &bytes[index..index + 2] == b"--" {
            line_comment = true;
            index += 2;
            continue;
        }
        match bytes[index] {
            b'\'' => {
                if single_quote && index + 1 < bytes.len() && bytes[index + 1] == b'\'' {
                    index += 2;
                    continue;
                }
                single_quote = !single_quote;
                index += 1;
            }
            b';' if !single_quote => {
                let statement = sql[start..index].trim();
                if !statement.is_empty() {
                    statements.push(statement.to_owned());
                }
                start = index + 1;
                index += 1;
            }
            _ => index += 1,
        }
    }
    let tail = sql[start..].trim();
    if !tail.is_empty() {
        statements.push(tail.to_owned());
    }
    statements
}

fn migration_0029() -> &'static sqlx::migrate::Migration {
    MIGRATOR
        .iter()
        .find(|migration| migration.version == 29)
        .expect("embedded migration 0029")
}

async fn legacy_snapshot(pool: &PgPool) -> Vec<String> {
    let tables = [
        "communities",
        "identity_bindings",
        "identity_principals",
        "identity_revoked_keys",
        "audit_log",
    ];
    let mut snapshot = Vec::new();
    for table in tables {
        let query = format!("SELECT to_jsonb(t)::text FROM {table} t ORDER BY 1");
        let rows = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(query))
            .fetch_all(pool)
            .await
            .expect("snapshot legacy rows");
        snapshot.extend(rows.into_iter().map(|row| format!("row:{table}:{row}")));
    }
    let catalog = sqlx::query_scalar::<_, String>(
        "SELECT value FROM (\
           SELECT 'column:'||table_name||':'||column_name||':'||data_type||':'||is_nullable||':'||COALESCE(column_default,'') AS value \
           FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'identity_%' \
           UNION ALL \
           SELECT 'constraint:'||conrelid::regclass::text||':'||conname||':'||pg_get_constraintdef(oid) \
           FROM pg_constraint WHERE conrelid::regclass::text LIKE 'identity_%' \
           UNION ALL \
           SELECT 'index:'||tablename||':'||indexname||':'||indexdef \
           FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'identity_%'\
         ) catalog ORDER BY value",
    )
    .fetch_all(pool)
    .await
    .expect("snapshot legacy catalog");
    snapshot.extend(catalog);
    let versions = sqlx::query_scalar::<_, i64>(
        "SELECT version FROM _sqlx_migrations WHERE success ORDER BY version",
    )
    .fetch_all(pool)
    .await
    .expect("snapshot migration versions");
    snapshot.extend(
        versions
            .into_iter()
            .map(|version| format!("version:{version}")),
    );
    snapshot.sort();
    snapshot
}

async fn full_identity_snapshot(pool: &PgPool) -> Vec<String> {
    let tables = [
        "identity_bindings",
        "identity_principals",
        "identity_revoked_keys",
        "identity_migration_denials",
        "identity_migration_denied_keys",
        "identity_binding_lineage",
        "identity_retired_pairs",
        "identity_pending_replacements",
        "identity_binding_history",
        "identity_lifecycle_operations",
        "audit_log",
    ];
    let mut snapshot = Vec::new();
    for table in tables {
        let query = format!("SELECT to_jsonb(t)::text FROM {table} t ORDER BY 1");
        let rows = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(query))
            .fetch_all(pool)
            .await
            .expect("snapshot migrated identity rows");
        snapshot.extend(rows.into_iter().map(|row| format!("{table}:{row}")));
    }
    let marker: Vec<String> =
        sqlx::query_scalar("SELECT to_jsonb(m)::text FROM _sqlx_migrations m WHERE version=29")
            .fetch_all(pool)
            .await
            .expect("snapshot 0029 marker");
    snapshot.extend(marker.into_iter().map(|row| format!("marker:{row}")));
    snapshot.sort();
    snapshot
}

async fn raw_domain_authorized(pool: &PgPool, domain: Uuid, key: &[u8]) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM identity_bindings \
         WHERE community_id=$1 AND pubkey=$2 AND revoked_at IS NULL)",
    )
    .bind(domain)
    .bind(key)
    .fetch_one(pool)
    .await
    .expect("read raw legacy authorization sentinel")
}

async fn domain_audit_snapshot(pool: &PgPool, domain: Uuid) -> Vec<String> {
    sqlx::query_scalar::<_, String>(
        "SELECT to_jsonb(row_value)::text FROM audit_log row_value \
         WHERE community_id=$1 ORDER BY 1",
    )
    .bind(domain)
    .fetch_all(pool)
    .await
    .expect("read domain audit sentinel")
}

async fn legacy_identity_facts(pool: &PgPool, domain: Uuid) -> Vec<String> {
    let mut facts = sqlx::query_scalar::<_, serde_json::Value>(
        "SELECT to_jsonb(binding)-ARRAY[\
            'binding_id','binding_version','binding_state','binding_provenance',\
            'replacement_binding_id','created_by','created_policy_version']::text[] \
         FROM identity_bindings binding WHERE community_id=$1",
    )
    .bind(domain)
    .fetch_all(pool)
    .await
    .expect("read legacy binding facts")
    .into_iter()
    .map(|value| format!("binding:{value}"))
    .collect::<Vec<_>>();
    for (table, query) in [
        (
            "principal",
            "SELECT to_jsonb(row_value) FROM identity_principals row_value WHERE community_id=$1",
        ),
        (
            "revoked_key",
            "SELECT to_jsonb(row_value) FROM identity_revoked_keys row_value WHERE community_id=$1",
        ),
    ] {
        let rows = sqlx::query_scalar::<_, serde_json::Value>(query)
            .bind(domain)
            .fetch_all(pool)
            .await
            .expect("read legacy selector facts");
        facts.extend(rows.into_iter().map(|value| format!("{table}:{value}")));
    }
    facts.sort();
    facts
}

async fn domain_identity_snapshot(pool: &PgPool, domain: Uuid) -> Vec<String> {
    let tables = [
        "identity_bindings",
        "identity_principals",
        "identity_revoked_keys",
        "identity_migration_denials",
        "identity_migration_denied_keys",
        "identity_binding_lineage",
        "identity_retired_pairs",
        "identity_pending_replacements",
        "identity_binding_history",
        "identity_lifecycle_operations",
        "audit_log",
    ];
    let mut snapshot = Vec::new();
    for table in tables {
        let query = format!(
            "SELECT to_jsonb(row_value)::text FROM {table} row_value WHERE community_id=$1 ORDER BY 1"
        );
        let rows = sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(query))
            .bind(domain)
            .fetch_all(pool)
            .await
            .expect("read domain identity snapshot");
        snapshot.extend(rows.into_iter().map(|row| format!("{table}:{row}")));
    }
    snapshot
}

async fn insert_rotated_legacy_row(
    pool: &PgPool,
    domain: Uuid,
    subject: &str,
    key: &[u8],
    target: &[u8],
) {
    sqlx::query(
        "INSERT INTO identity_bindings \
         (community_id,issuer,uid,pubkey,source,revoked_at,revoked_reason,revocation_scope,\
          rotation_completed_at,rotated_to_pubkey,rotation_reason) \
         VALUES ($1,'https://idp.example',$2,$3,'db_binding',NOW(),'legacy rotation',\
                 'rotation',NOW(),$4,'legacy rotation')",
    )
    .bind(domain)
    .bind(subject)
    .bind(key)
    .bind(target)
    .execute(pool)
    .await
    .expect("insert rotated legacy row");
}

async fn insert_revoked_legacy_row(pool: &PgPool, domain: Uuid, subject: &str, key: &[u8]) {
    sqlx::query(
        "INSERT INTO identity_bindings \
         (community_id,issuer,uid,pubkey,source,revoked_at,revoked_reason,revocation_scope) \
         VALUES ($1,'https://idp.example',$2,$3,'db_binding',NOW(),'legacy revoke','key')",
    )
    .bind(domain)
    .bind(subject)
    .bind(key)
    .execute(pool)
    .await
    .expect("insert revoked legacy row");
}

fn lifecycle_context(id: u128, reason: &'static str) -> LifecycleContext<'static> {
    LifecycleContext {
        operation_id: Uuid::from_u128(id),
        actor: None,
        reason,
    }
}

fn replacement(
    key: &'static [u8; 32],
    provenance: BindingProvenance,
) -> VerifiedReplacementKey<'static> {
    VerifiedReplacementKey::after_verified_proof(
        key,
        None,
        provenance,
        Some("migration-denial-policy-v1"),
    )
    .expect("construct migrated denial replacement")
}

#[tokio::test]
#[ignore = "requires a dedicated disposable Postgres database"]
async fn identity_0029_fault_at_every_statement_boundary_restarts_and_retries() {
    let statements = split_statements(migration_0029().sql.as_ref());
    assert_eq!(
        statements.len(),
        28,
        "0029 boundary count is part of the oracle adapter"
    );

    for boundary in 0..=statements.len() {
        let pool = connect_pool().await;
        let (_domain_a, domain_b) = reset_to_0028(&pool).await;
        let before = legacy_snapshot(&pool).await;
        let domain_b_facts = legacy_identity_facts(&pool, domain_b).await;
        let domain_b_audit = domain_audit_snapshot(&pool, domain_b).await;
        assert!(raw_domain_authorized(&pool, domain_b, &[72_u8; 32]).await);

        let mut connection = pool.acquire().await.expect("acquire crashable backend");
        let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *connection)
            .await
            .expect("read crashable backend pid");
        let mut tx = connection
            .begin()
            .await
            .expect("begin crashable boundary migration");
        for statement in &statements[..boundary] {
            sqlx::raw_sql(sqlx::AssertSqlSafe(statement.as_str()))
                .execute(&mut *tx)
                .await
                .unwrap_or_else(|error| {
                    panic!("0029 statement before boundary {boundary} failed: {error}")
                });
        }
        let terminated: bool = sqlx::query_scalar("SELECT pg_terminate_backend($1)")
            .bind(backend_pid)
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|error| {
                panic!("terminate boundary {boundary} migration backend: {error}")
            });
        assert!(terminated, "boundary {boundary} backend must terminate");
        assert!(
            sqlx::query("SELECT 1").execute(&mut *tx).await.is_err(),
            "boundary {boundary} transaction must observe backend loss"
        );
        drop(tx);
        drop(connection);
        pool.close().await;

        let pool = connect_pool().await;
        assert_eq!(legacy_snapshot(&pool).await, before, "boundary {boundary}");
        assert_eq!(
            legacy_identity_facts(&pool, domain_b).await,
            domain_b_facts,
            "boundary {boundary} domain-B facts before retry"
        );
        assert_eq!(
            domain_audit_snapshot(&pool, domain_b).await,
            domain_b_audit,
            "boundary {boundary} domain-B audit before retry"
        );
        assert!(raw_domain_authorized(&pool, domain_b, &[72_u8; 32]).await);

        MIGRATOR.run_to(29, &pool).await.unwrap_or_else(|error| {
            panic!("boundary {boundary} retry after restart failed: {error}")
        });
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM _sqlx_migrations WHERE version=29 AND success"
            )
            .fetch_one(&pool)
            .await
            .expect("count boundary retry marker"),
            1,
            "boundary {boundary} must produce one durable migration marker"
        );
        assert_eq!(
            legacy_identity_facts(&pool, domain_b).await,
            domain_b_facts,
            "boundary {boundary} domain-B facts after retry"
        );
        assert_eq!(
            domain_audit_snapshot(&pool, domain_b).await,
            domain_b_audit,
            "boundary {boundary} domain-B audit after retry"
        );
        assert!(raw_domain_authorized(&pool, domain_b, &[72_u8; 32]).await);
        let complete_post = full_identity_snapshot(&pool).await;
        pool.close().await;

        let pool = connect_pool().await;
        assert_eq!(
            full_identity_snapshot(&pool).await,
            complete_post,
            "boundary {boundary} complete post-state must survive restart"
        );
        MIGRATOR.run_to(29, &pool).await.unwrap_or_else(|error| {
            panic!("boundary {boundary} idempotent post-restart retry failed: {error}")
        });
        assert_eq!(
            full_identity_snapshot(&pool).await,
            complete_post,
            "boundary {boundary} retry must remain an exact no-op"
        );
        pool.close().await;
    }
}

#[tokio::test]
#[ignore = "requires a dedicated disposable Postgres database"]
async fn identity_0029_commit_failure_rolls_back_projection_and_success_marker() {
    let pool = connect_pool().await;
    let (_domain_a, domain_b) = reset_to_0028(&pool).await;
    let before = legacy_snapshot(&pool).await;
    let migration = migration_0029();
    let statements = split_statements(migration.sql.as_ref());
    let mut tx = pool.begin().await.expect("begin commit-failure migration");
    for statement in statements {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement))
            .execute(&mut *tx)
            .await
            .expect("execute 0029 before commit failure");
    }
    sqlx::query(
        "INSERT INTO _sqlx_migrations \
         (version,description,installed_on,success,checksum,execution_time) \
         VALUES ($1,$2,NOW(),TRUE,$3,0)",
    )
    .bind(migration.version)
    .bind(migration.description.as_ref())
    .bind(migration.checksum.as_ref())
    .execute(&mut *tx)
    .await
    .expect("insert transactional 0029 marker");
    sqlx::query(
        "UPDATE identity_bindings SET replacement_binding_id=$1 \
         WHERE community_id=$2",
    )
    .bind(Uuid::from_u128(u128::MAX))
    .bind(domain_b)
    .execute(&mut *tx)
    .await
    .expect("deferred FK accepts invalid replacement before commit");
    assert!(
        tx.commit().await.is_err(),
        "deferred FK must fail at commit"
    );
    assert_eq!(legacy_snapshot(&pool).await, before);
    assert!(raw_domain_authorized(&pool, domain_b, &[72_u8; 32]).await);

    MIGRATOR
        .run_to(29, &pool)
        .await
        .expect("retry after commit failure");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM _sqlx_migrations WHERE version=29 AND success"
        )
        .fetch_one(&pool)
        .await
        .expect("count successful 0029 marker"),
        1
    );
}

#[tokio::test]
#[ignore = "requires a dedicated disposable Postgres database"]
async fn identity_0029_backend_loss_restarts_cleanly_and_retry_converges() {
    let pool = connect_pool().await;
    let (_domain_a, domain_b) = reset_to_0028(&pool).await;
    let before = legacy_snapshot(&pool).await;
    let statements = split_statements(migration_0029().sql.as_ref());
    let mut connection = pool.acquire().await.expect("acquire migration backend");
    let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *connection)
        .await
        .expect("read migration backend pid");
    let mut tx = connection.begin().await.expect("begin crashable migration");
    for statement in &statements[..statements.len() / 2] {
        sqlx::raw_sql(sqlx::AssertSqlSafe(statement.as_str()))
            .execute(&mut *tx)
            .await
            .expect("execute pre-crash migration prefix");
    }
    let terminated: bool = sqlx::query_scalar("SELECT pg_terminate_backend($1)")
        .bind(backend_pid)
        .fetch_one(&pool)
        .await
        .expect("terminate migration backend");
    assert!(terminated);
    assert!(sqlx::query("SELECT 1").execute(&mut *tx).await.is_err());
    drop(tx);
    drop(connection);
    pool.close().await;

    let pool = connect_pool().await;
    assert_eq!(legacy_snapshot(&pool).await, before);
    assert!(raw_domain_authorized(&pool, domain_b, &[72_u8; 32]).await);
    MIGRATOR
        .run_to(29, &pool)
        .await
        .expect("retry after backend restart");
}

#[tokio::test]
#[ignore = "requires a dedicated disposable Postgres database"]
async fn identity_0029_post_commit_response_loss_is_idempotent_after_restart() {
    let pool = connect_pool().await;
    reset_to_0028(&pool).await;
    MIGRATOR
        .run_to(29, &pool)
        .await
        .expect("commit 0029 before response loss");
    let committed = full_identity_snapshot(&pool).await;
    let synthetic_response: Result<(), &str> = Err("response lost after confirmed commit");
    assert!(synthetic_response.is_err());
    pool.close().await;

    let pool = connect_pool().await;
    assert_eq!(full_identity_snapshot(&pool).await, committed);
    MIGRATOR
        .run_to(29, &pool)
        .await
        .expect("idempotent retry after response loss");
    assert_eq!(full_identity_snapshot(&pool).await, committed);
}

#[tokio::test]
#[ignore = "requires a dedicated disposable Postgres database"]
async fn identity_0029_readable_ambiguities_preserve_facts_and_never_create_authority() {
    static PROVISION_KEY: [u8; 32] = [91; 32];
    static ROTATE_KEY: [u8; 32] = [92; 32];
    static RECOVER_KEY: [u8; 32] = [93; 32];
    static ENABLE_KEY: [u8; 32] = [94; 32];

    let pool = connect_pool().await;
    let (domain_a, domain_b) = reset_to_0028(&pool).await;
    let active_key = vec![71_u8; 32];
    let missing_predecessor = vec![73_u8; 32];
    let missing_target = vec![74_u8; 32];
    insert_rotated_legacy_row(
        &pool,
        domain_a,
        "migration-fault-a-subject",
        &missing_predecessor,
        &missing_target,
    )
    .await;

    let duplicate_key = vec![80_u8; 32];
    insert_revoked_legacy_row(&pool, domain_a, "duplicate", &duplicate_key).await;
    insert_revoked_legacy_row(&pool, domain_a, "duplicate", &duplicate_key).await;

    let cycle_a = vec![81_u8; 32];
    let cycle_b = vec![82_u8; 32];
    insert_rotated_legacy_row(&pool, domain_a, "cycle", &cycle_a, &cycle_b).await;
    insert_rotated_legacy_row(&pool, domain_a, "cycle", &cycle_b, &cycle_a).await;

    let fork_source = vec![83_u8; 32];
    let fork_target = vec![84_u8; 32];
    insert_rotated_legacy_row(&pool, domain_a, "fork", &fork_source, &fork_target).await;
    insert_revoked_legacy_row(&pool, domain_a, "fork", &fork_target).await;
    insert_revoked_legacy_row(&pool, domain_a, "fork", &fork_target).await;

    let conflicting_key = vec![85_u8; 32];
    sqlx::query(
        "INSERT INTO identity_bindings (community_id,issuer,uid,pubkey,source) \
         VALUES ($1,'https://idp.example','active-with-tombstone',$2,'db_binding')",
    )
    .bind(domain_a)
    .bind(&conflicting_key)
    .execute(&pool)
    .await
    .expect("insert active binding selected by legacy tombstone");
    sqlx::query(
        "INSERT INTO identity_revoked_keys (community_id,pubkey,reason) \
         VALUES ($1,$2,'legacy key tombstone')",
    )
    .bind(domain_a)
    .bind(&conflicting_key)
    .execute(&pool)
    .await
    .expect("insert conflicting legacy tombstone");

    let legacy_a = legacy_identity_facts(&pool, domain_a).await;
    let legacy_b = legacy_identity_facts(&pool, domain_b).await;
    MIGRATOR
        .run_to(29, &pool)
        .await
        .expect("readable ambiguity migrates into fail-closed quarantine");
    assert_eq!(legacy_identity_facts(&pool, domain_a).await, legacy_a);
    assert_eq!(legacy_identity_facts(&pool, domain_b).await, legacy_b);

    let quarantined: Vec<String> = sqlx::query_scalar(
        "SELECT subject FROM identity_migration_denials WHERE community_id=$1 ORDER BY subject",
    )
    .bind(domain_a)
    .fetch_all(&pool)
    .await
    .expect("read principal quarantines");
    assert_eq!(
        quarantined,
        vec![
            "cycle".to_owned(),
            "duplicate".to_owned(),
            "fork".to_owned(),
            "migration-fault-a-subject".to_owned(),
        ]
    );
    for key in [
        active_key.as_slice(),
        missing_predecessor.as_slice(),
        missing_target.as_slice(),
        duplicate_key.as_slice(),
        cycle_a.as_slice(),
        cycle_b.as_slice(),
        fork_source.as_slice(),
        fork_target.as_slice(),
    ] {
        let denied: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM identity_migration_denied_keys \
             WHERE community_id=$1 AND pubkey=$2)",
        )
        .bind(domain_a)
        .bind(key)
        .fetch_one(&pool)
        .await
        .expect("read implicated key quarantine");
        assert!(
            denied,
            "every stored or referenced implicated key is denied"
        );
    }
    let imported_ambiguous_edges: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM identity_binding_lineage lineage \
         JOIN identity_bindings binding \
           ON binding.community_id=lineage.community_id \
          AND binding.binding_id=lineage.predecessor_binding_id \
         WHERE binding.community_id=$1 AND binding.uid IN \
               ('cycle','duplicate','fork','migration-fault-a-subject')",
    )
    .bind(domain_a)
    .fetch_one(&pool)
    .await
    .expect("count ambiguous imported lineage");
    assert_eq!(imported_ambiguous_edges, 0);

    let domain_a_id = CommunityId::from_uuid(domain_a);
    let domain_b_id = CommunityId::from_uuid(domain_b);
    let main_principal = IdentityPrincipal {
        issuer: "https://idp.example",
        subject: "migration-fault-a-subject",
    };
    assert!(
        get_active_identity_binding_by_pubkey(&pool, domain_a_id, &active_key)
            .await
            .is_err()
    );
    assert!(
        get_active_identity_binding_by_pubkey(&pool, domain_a_id, &conflicting_key)
            .await
            .is_err()
    );
    for (subject, key) in [
        (main_principal.subject, active_key.as_slice()),
        ("different-principal", missing_target.as_slice()),
        ("active-with-tombstone", conflicting_key.as_slice()),
    ] {
        let result = resolve_identity_binding(
            &pool,
            domain_a_id,
            &ResolveBindingInput {
                issuer: "https://idp.example",
                subject,
                pubkey: key,
                display_name: None,
                enrollment_mode: EnrollmentMode::AttestedKey,
                key_attested: true,
            },
        )
        .await
        .expect("migrated denial resolves without authority");
        assert_eq!(result, ResolveBindingResult::Denied(BindingDenial::Revoked));
    }

    let domain_b_cross = resolve_identity_binding(
        &pool,
        domain_b_id,
        &ResolveBindingInput {
            issuer: "https://idp.example",
            subject: "independent-domain-subject",
            pubkey: &missing_target,
            display_name: None,
            enrollment_mode: EnrollmentMode::AttestedKey,
            key_attested: true,
        },
    )
    .await
    .expect("same bytes remain independent in domain B");
    assert!(matches!(domain_b_cross, ResolveBindingResult::Enrolled(_)));
    let domain_b_sentinel = domain_identity_snapshot(&pool, domain_b).await;

    let (retired_binding_id, retired_binding_version): (Uuid, i64) = sqlx::query_as(
        "SELECT binding_id,binding_version FROM identity_bindings \
         WHERE community_id=$1 AND issuer='https://idp.example' \
           AND uid='migration-fault-a-subject' AND pubkey=$2",
    )
    .bind(domain_a)
    .bind(&missing_predecessor)
    .fetch_one(&pool)
    .await
    .expect("read quarantined retired coordinate");
    let fabricated_pending = PendingLineage {
        retired_pubkey: missing_predecessor.clone(),
        retired_binding_id,
        retired_binding_version: u64::try_from(retired_binding_version).expect("positive version"),
        selector_version: 1,
    };
    let before_denials = domain_identity_snapshot(&pool, domain_a).await;
    assert!(provision_identity_binding(
        &pool,
        domain_a_id,
        lifecycle_context(301, "quarantine provision denial"),
        main_principal,
        EnrollmentMode::Provisioned,
        replacement(&PROVISION_KEY, BindingProvenance::Provisioned),
    )
    .await
    .is_err());
    assert!(retire_identity_pair(
        &pool,
        domain_a_id,
        lifecycle_context(302, "quarantine retire denial"),
        main_principal,
        &active_key,
    )
    .await
    .is_err());
    assert!(disable_identity_principal(
        &pool,
        domain_a_id,
        lifecycle_context(303, "quarantine disable denial"),
        main_principal,
    )
    .await
    .is_err());
    assert!(revoke_identity_key(
        &pool,
        domain_a_id,
        lifecycle_context(304, "quarantine revoke denial"),
        &active_key,
    )
    .await
    .is_err());
    assert!(rotate_identity_binding(
        &pool,
        domain_a_id,
        lifecycle_context(305, "quarantine rotate denial"),
        main_principal,
        &active_key,
        replacement(&ROTATE_KEY, BindingProvenance::AttestedKey),
    )
    .await
    .is_err());
    assert!(recover_identity_binding(
        &pool,
        domain_a_id,
        lifecycle_context(306, "quarantine recover denial"),
        main_principal,
        &fabricated_pending,
        replacement(&RECOVER_KEY, BindingProvenance::AttestedKey),
    )
    .await
    .is_err());
    assert!(enable_identity_principal(
        &pool,
        domain_a_id,
        lifecycle_context(307, "quarantine enable denial"),
        main_principal,
        Some(&fabricated_pending),
        replacement(&ENABLE_KEY, BindingProvenance::AttestedKey),
    )
    .await
    .is_err());
    assert_eq!(
        domain_identity_snapshot(&pool, domain_a).await,
        before_denials
    );
    assert_eq!(
        domain_identity_snapshot(&pool, domain_b).await,
        domain_b_sentinel
    );
    assert!(
        get_active_identity_binding_by_pubkey(&pool, domain_b_id, &missing_target)
            .await
            .expect("domain-B authorization sentinel")
            .is_some()
    );
}
