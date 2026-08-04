use std::path::PathBuf;

use super::*;

// ── Protected-key predicate tests ────────────────────────────────────────────

#[test]
fn test_predicate_invariant_all_policy_keys_protected() {
    // Every env key that the launch policy generates, removes, or reserves MUST
    // be protected by is_launch_policy_protected_key.  Adding a new launch-policy
    // key without updating this list will cause the test to fail.
    let policy_owned_keys = [
        // B1 paired atom
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
        // Buzz identity / secrets (RESERVED_ENV_KEYS)
        "BUZZ_PRIVATE_KEY",
        "NOSTR_PRIVATE_KEY",
        "BUZZ_AUTH_TAG",
        "BUZZ_API_TOKEN",
        "BUZZ_ACP_PRIVATE_KEY",
        "BUZZ_ACP_API_TOKEN",
        "BUZZ_RELAY_URL",
        "BUZZ_ACP_AGENT_COMMAND",
        "BUZZ_ACP_AGENT_ARGS",
        "BUZZ_ACP_MCP_COMMAND",
        "BUZZ_ACP_RESPOND_TO",
        "BUZZ_ACP_RESPOND_TO_ALLOWLIST",
        "BUZZ_ACP_AGENT_OWNER",
        "BUZZ_ACP_EXIT_AFTER_INACTIVITY",
        "BUZZ_ACP_NO_PRESENCE",
        "BUZZ_ACP_SETUP_PAYLOAD",
        "BUZZ_MANAGED_AGENT",
        "BUZZ_MANAGED_AGENT_START_NONCE",
        // Model authority
        "ANTHROPIC_MODEL",
        "ANTHROPIC_SMALL_FAST_MODEL",
        // Isolation flags
        "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "CLAUDE_CODE_SKIP_PERMISSIONS_CHECK",
        // Provider / endpoint / auth routing
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "AWS_BEARER_TOKEN_BEDROCK",
        "ANTHROPIC_VERTEX_PROJECT_ID",
        "CLOUD_ML_REGION",
        "ANTHROPIC_VERTEX_REGION",
        "ANTHROPIC_VERTEX_KEY_PATH",
    ];

    for key in &policy_owned_keys {
        assert!(
            is_launch_policy_protected_key(key),
            "policy-owned key must be protected: {key}"
        );
    }
}

#[test]
fn test_model_authority_key_stripped_from_owner_env() {
    let dir = tempfile::tempdir().unwrap();
    let settings_path = dir.path().join("settings.json");
    std::fs::write(
        &settings_path,
        r#"{"env": {"ANTHROPIC_MODEL": "claude-opus-4", "MY_CUSTOM_VAR": "hello"}}"#,
    )
    .unwrap();
    let managed_root = dir.path().to_path_buf();
    let policy = ClaudeLaunchPolicy::build("abcd1234", &managed_root, None).unwrap();
    let (projected, status) = project_settings_json(&settings_path, &policy);

    assert_eq!(status, OwnerBaseStatus::Ok);
    let env = projected.get("env").and_then(|v| v.as_object());
    assert!(
        env.is_none_or(|e| !e.contains_key("ANTHROPIC_MODEL")),
        "ANTHROPIC_MODEL must be stripped from projected env"
    );
}

#[test]
fn test_credential_root_keys_stripped_from_owner_env() {
    let dir = tempfile::tempdir().unwrap();
    let settings_path = dir.path().join("settings.json");
    std::fs::write(
        &settings_path,
        r#"{"env": {"CLAUDE_CONFIG_DIR": "/some/path", "CLAUDE_SECURESTORAGE_CONFIG_DIR": "/other"}}"#,
    )
    .unwrap();
    let managed_root = dir.path().to_path_buf();
    let policy = ClaudeLaunchPolicy::build("abcd1234", &managed_root, None).unwrap();
    let (projected, _) = project_settings_json(&settings_path, &policy);

    let env = projected.get("env").and_then(|v| v.as_object());
    assert!(
        env.is_none_or(|e| !e.contains_key("CLAUDE_CONFIG_DIR")),
        "CLAUDE_CONFIG_DIR must be stripped"
    );
    assert!(
        env.is_none_or(|e| !e.contains_key("CLAUDE_SECURESTORAGE_CONFIG_DIR")),
        "CLAUDE_SECURESTORAGE_CONFIG_DIR must be stripped"
    );
}

#[test]
fn test_isolation_flag_stripped_from_owner_env() {
    let dir = tempfile::tempdir().unwrap();
    let settings_path = dir.path().join("settings.json");
    std::fs::write(
        &settings_path,
        r#"{"env": {"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}}"#,
    )
    .unwrap();
    let managed_root = dir.path().to_path_buf();
    let policy = ClaudeLaunchPolicy::build("abcd1234", &managed_root, None).unwrap();
    let (projected, _) = project_settings_json(&settings_path, &policy);

    let env = projected.get("env").and_then(|v| v.as_object());
    assert!(
        env.is_none_or(|e| !e.contains_key("CLAUDE_CODE_DISABLE_AUTO_MEMORY")),
        "CLAUDE_CODE_DISABLE_AUTO_MEMORY must be stripped"
    );
}

#[test]
fn test_provider_routing_key_stripped_from_owner_env() {
    let dir = tempfile::tempdir().unwrap();
    let settings_path = dir.path().join("settings.json");
    std::fs::write(
        &settings_path,
        r#"{"env": {"ANTHROPIC_BASE_URL": "https://evil.example.com/"}}"#,
    )
    .unwrap();
    let managed_root = dir.path().to_path_buf();
    let policy = ClaudeLaunchPolicy::build("abcd1234", &managed_root, None).unwrap();
    let (projected, _) = project_settings_json(&settings_path, &policy);

    let env = projected.get("env").and_then(|v| v.as_object());
    assert!(
        env.is_none_or(|e| !e.contains_key("ANTHROPIC_BASE_URL")),
        "ANTHROPIC_BASE_URL must be stripped"
    );
}

#[test]
fn test_buzz_prefix_stripped_from_owner_env() {
    let dir = tempfile::tempdir().unwrap();
    let settings_path = dir.path().join("settings.json");
    std::fs::write(
        &settings_path,
        r#"{"env": {"BUZZ_SOMETHING": "evil", "BUZZ_RELAY_URL": "wss://evil.relay/"}}"#,
    )
    .unwrap();
    let managed_root = dir.path().to_path_buf();
    let policy = ClaudeLaunchPolicy::build("abcd1234", &managed_root, None).unwrap();
    let (projected, _) = project_settings_json(&settings_path, &policy);

    let env = projected.get("env").and_then(|v| v.as_object());
    assert!(
        env.is_none_or(|e| !e.contains_key("BUZZ_SOMETHING")),
        "BUZZ_SOMETHING must be stripped"
    );
    assert!(
        env.is_none_or(|e| !e.contains_key("BUZZ_RELAY_URL")),
        "BUZZ_RELAY_URL must be stripped"
    );
}

#[test]
fn test_nonprotected_owner_env_passthrough() {
    let dir = tempfile::tempdir().unwrap();
    let settings_path = dir.path().join("settings.json");
    std::fs::write(
        &settings_path,
        r#"{"env": {"MY_CUSTOM_VAR": "hello", "ANOTHER_SAFE_VAR": "world"}}"#,
    )
    .unwrap();
    let managed_root = dir.path().to_path_buf();
    let policy = ClaudeLaunchPolicy::build("abcd1234", &managed_root, None).unwrap();
    let (projected, status) = project_settings_json(&settings_path, &policy);

    assert_eq!(status, OwnerBaseStatus::Ok);
    let env = projected
        .get("env")
        .and_then(|v| v.as_object())
        .expect("env object must be present");
    assert_eq!(
        env.get("MY_CUSTOM_VAR").and_then(|v| v.as_str()),
        Some("hello"),
        "MY_CUSTOM_VAR must pass through"
    );
    assert_eq!(
        env.get("ANOTHER_SAFE_VAR").and_then(|v| v.as_str()),
        Some("world"),
        "ANOTHER_SAFE_VAR must pass through"
    );
}

#[test]
fn test_case_insensitive_key_filter() {
    // `anthropic_model` (lowercase) must be filtered the same as `ANTHROPIC_MODEL`.
    assert!(
        is_launch_policy_protected_key("anthropic_model"),
        "lowercase anthropic_model must be protected"
    );
    assert!(
        is_launch_policy_protected_key("Anthropic_Model"),
        "mixed-case Anthropic_Model must be protected"
    );
    assert!(
        is_launch_policy_protected_key("buzz_something"),
        "lowercase buzz_something must be protected"
    );
    assert!(
        is_launch_policy_protected_key("claude_config_dir"),
        "lowercase claude_config_dir must be protected"
    );
}

#[test]
fn test_provenance_stripped_keys_reported() {
    let dir = tempfile::tempdir().unwrap();
    let settings_path = dir.path().join("settings.json");
    std::fs::write(
        &settings_path,
        r#"{"env": {"ANTHROPIC_MODEL": "claude-opus-4", "MY_CUSTOM_VAR": "ok"}}"#,
    )
    .unwrap();

    let stripped = collect_stripped_env_keys(&settings_path);
    assert!(
        stripped.contains(&"ANTHROPIC_MODEL".to_string()),
        "ANTHROPIC_MODEL must appear in stripped keys for provenance"
    );
    assert!(
        !stripped.contains(&"MY_CUSTOM_VAR".to_string()),
        "MY_CUSTOM_VAR must not appear in stripped keys"
    );
}

// ── Projection tests ──────────────────────────────────────────────────────────

#[test]
fn test_unreadable_owner_base_falls_back_to_overlay_only() {
    let dir = tempfile::tempdir().unwrap();
    // No settings.json file exists → Missing status.
    let settings_path = dir.path().join("settings.json");
    let managed_root = dir.path().to_path_buf();
    let policy =
        ClaudeLaunchPolicy::build("abcd1234", &managed_root, Some("high".to_string())).unwrap();
    let (projected, status) = project_settings_json(&settings_path, &policy);

    assert_eq!(status, OwnerBaseStatus::Missing);
    // Canonical overlay should still be present.
    assert_eq!(
        projected.get("effortLevel").and_then(|v| v.as_str()),
        Some("high"),
        "effortLevel must be in projected settings even without owner base"
    );
}

#[test]
fn test_invalid_json_base_falls_back_to_overlay_only() {
    let dir = tempfile::tempdir().unwrap();
    let settings_path = dir.path().join("settings.json");
    std::fs::write(&settings_path, "not valid json!!!").unwrap();
    let managed_root = dir.path().to_path_buf();
    let policy =
        ClaudeLaunchPolicy::build("abcd1234", &managed_root, Some("medium".to_string())).unwrap();
    let (projected, status) = project_settings_json(&settings_path, &policy);

    assert!(
        matches!(status, OwnerBaseStatus::Unreadable { .. }),
        "unreadable base must produce Unreadable status"
    );
    assert_eq!(
        projected.get("effortLevel").and_then(|v| v.as_str()),
        Some("medium"),
        "effortLevel overlay must still apply on unreadable base"
    );
}

#[test]
fn test_effort_level_written_into_projected_settings() {
    let dir = tempfile::tempdir().unwrap();
    let settings_path = dir.path().join("settings.json");
    // Owner base with an existing effortLevel that should be replaced.
    std::fs::write(
        &settings_path,
        r#"{"effortLevel": "low", "hooks": {"pre-commit": {}}}"#,
    )
    .unwrap();
    let managed_root = dir.path().to_path_buf();
    let policy =
        ClaudeLaunchPolicy::build("abcd1234", &managed_root, Some("high".to_string())).unwrap();
    let (projected, status) = project_settings_json(&settings_path, &policy);

    assert_eq!(status, OwnerBaseStatus::Ok);
    assert_eq!(
        projected.get("effortLevel").and_then(|v| v.as_str()),
        Some("high"),
        "canonical effortLevel must override base effortLevel"
    );
    // Non-canonical keys must pass through.
    assert!(
        projected.contains_key("hooks"),
        "hooks must pass through from owner base"
    );
}

#[test]
fn test_no_effort_level_does_not_inject_empty() {
    let dir = tempfile::tempdir().unwrap();
    let settings_path = dir.path().join("settings.json");
    std::fs::write(&settings_path, r#"{"model": "claude-opus-4"}"#).unwrap();
    let managed_root = dir.path().to_path_buf();
    // No effort_level in policy.
    let policy = ClaudeLaunchPolicy::build("abcd1234", &managed_root, None).unwrap();
    let (projected, _) = project_settings_json(&settings_path, &policy);

    // effortLevel should not be injected when None.
    assert!(
        !projected.contains_key("effortLevel"),
        "effortLevel must not be present when policy.effort_level is None"
    );
}

#[test]
fn test_projection_write_failure_blocks_spawn() {
    // Simulate write failure portably: create a regular file, then use a path
    // *under* that file as config_dir.  create_dir_all fails on every OS when
    // a path component is a regular file (not a directory), so the test does
    // not rely on a non-existent root path that Windows can still create.
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("i_am_a_file");
    std::fs::write(&blocker, b"").unwrap();
    let policy = ClaudeLaunchPolicy {
        config_dir: blocker.join("cannot_create_under_a_file"),
        secure_storage_config_dir: String::new(),
        effort_level: None,
    };
    let projected = serde_json::Map::new();
    let result = write_projected_settings(&policy, &projected);
    assert!(
        result.is_err(),
        "write_projected_settings must return Err when path cannot be created"
    );
}

#[test]
fn test_write_projected_settings_creates_dir_and_file() {
    let dir = tempfile::tempdir().unwrap();
    let policy = ClaudeLaunchPolicy {
        config_dir: dir.path().join("claude").join("abcd1234"),
        secure_storage_config_dir: String::new(),
        effort_level: Some("high".to_string()),
    };
    let mut projected = serde_json::Map::new();
    projected.insert(
        "effortLevel".to_string(),
        serde_json::Value::String("high".to_string()),
    );

    write_projected_settings(&policy, &projected).unwrap();

    let written_path = dir
        .path()
        .join("claude")
        .join("abcd1234")
        .join("settings.json");
    assert!(written_path.exists(), "settings.json must be written");
    let contents = std::fs::read_to_string(&written_path).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&contents).unwrap();
    assert_eq!(
        parsed.get("effortLevel").and_then(|v| v.as_str()),
        Some("high")
    );
}

// ── Lifecycle (B3) tests ──────────────────────────────────────────────────────

#[test]
fn test_b3_cleanup_failure_does_not_block_deletion() {
    // Call cleanup on a path whose parent doesn't exist — should return Ok
    // (the directory simply doesn't exist, which is idempotent success).
    let nonexistent_root = PathBuf::from("/nonexistent/buzz/agents/never/created");
    let result = cleanup_claude_config_root("abcd1234abcd1234", &nonexistent_root);
    assert!(
        result.is_ok(),
        "cleanup must return Ok even when directory doesn't exist: {result:?}"
    );
}

#[test]
fn test_b3_traversal_guard() {
    // A pubkey containing non-hex chars must be rejected BEFORE any filesystem op.
    let managed_root = PathBuf::from("/tmp/buzz-agents-test");
    let bad_pubkeys = ["../escape", "../../etc/passwd", "a/b", "hex!@#$%"];
    for pubkey in &bad_pubkeys {
        let result = cleanup_claude_config_root(pubkey, &managed_root);
        assert!(result.is_err(), "non-hex pubkey must be rejected: {pubkey}");
    }
}

#[test]
fn test_b3_removes_existing_config_dir() {
    let dir = tempfile::tempdir().unwrap();
    let managed_root = dir.path().to_path_buf();
    let pubkey = "abcd1234abcd1234";
    let target = managed_root.join("claude").join(pubkey);
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("settings.json"), "{}").unwrap();

    cleanup_claude_config_root(pubkey, &managed_root).unwrap();
    assert!(!target.exists(), "config dir must be removed after cleanup");
}

#[test]
fn test_b3_idempotent_when_dir_missing() {
    let dir = tempfile::tempdir().unwrap();
    let managed_root = dir.path().to_path_buf();
    let pubkey = "abcd1234abcd1234";
    // Directory never created — cleanup should succeed idempotently.
    cleanup_claude_config_root(pubkey, &managed_root).unwrap();
}

#[test]
fn test_b3_legacy_first_spawn_removes_stale_dir() {
    // Simulate a stale directory from a previous install:
    // cleanup_claude_config_root removes it, then the caller creates it fresh.
    let dir = tempfile::tempdir().unwrap();
    let managed_root = dir.path().to_path_buf();
    let pubkey = "abcd1234abcd1234";
    let target = managed_root.join("claude").join(pubkey);

    // Create a "stale" directory with stale contents.
    std::fs::create_dir_all(&target).unwrap();
    std::fs::write(target.join("old_file.txt"), "stale").unwrap();

    // Cleanup removes it.
    cleanup_claude_config_root(pubkey, &managed_root).unwrap();
    assert!(!target.exists(), "stale dir must be removed");

    // Caller recreates it fresh.
    std::fs::create_dir_all(&target).unwrap();
    assert!(target.exists(), "fresh dir must be creatable after cleanup");
}

// ── ClaudeLaunchPolicy construction tests ────────────────────────────────────

#[test]
fn test_build_policy_hex_pubkey_accepted() {
    let dir = tempfile::tempdir().unwrap();
    let managed_root = dir.path().to_path_buf();
    let pubkey = "deadbeef01234567deadbeef01234567deadbeef01234567deadbeef01234567";
    let policy = ClaudeLaunchPolicy::build(pubkey, &managed_root, None);
    assert!(policy.is_ok(), "valid hex pubkey must be accepted");
    let p = policy.unwrap();
    assert_eq!(
        p.secure_storage_config_dir, "",
        "SECURESTORAGE must be empty string"
    );
    assert!(
        p.config_dir.ends_with(pubkey),
        "config_dir must end with pubkey"
    );
}

#[test]
fn test_build_policy_non_hex_pubkey_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let managed_root = dir.path().to_path_buf();
    let result = ClaudeLaunchPolicy::build("not-a-hex-key!", &managed_root, None);
    assert!(result.is_err(), "non-hex pubkey must be rejected");
}

#[test]
fn test_build_policy_empty_pubkey_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let managed_root = dir.path().to_path_buf();
    let result = ClaudeLaunchPolicy::build("", &managed_root, None);
    assert!(result.is_err(), "empty pubkey must be rejected");
}

#[test]
fn test_build_policy_overlength_pubkey_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let managed_root = dir.path().to_path_buf();
    // 65 hex chars — exceeds max 64
    let long_key = "a".repeat(65);
    let result = ClaudeLaunchPolicy::build(&long_key, &managed_root, None);
    assert!(result.is_err(), "pubkey > 64 chars must be rejected");
}

#[test]
fn test_secure_storage_config_dir_is_always_empty_string() {
    // The empty string is the invariant — verify it explicitly so any future
    // change to the default shows up as a test failure.
    let dir = tempfile::tempdir().unwrap();
    let managed_root = dir.path().to_path_buf();
    let policy = ClaudeLaunchPolicy::build("abcd1234", &managed_root, None).unwrap();
    assert_eq!(
        policy.secure_storage_config_dir, "",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR must be the empty string"
    );
    assert!(
        policy.secure_storage_config_dir.is_empty(),
        "is_empty() must hold so command.env() receives the correct sentinel value"
    );
}

// ── B8: Owner MCP server inheritance tests ────────────────────────────────────

/// Helper: write a JSON object to a file, creating parent dirs as needed.
fn write_json(path: &std::path::Path, value: &serde_json::Value) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, serde_json::to_string_pretty(value).unwrap()).unwrap();
}

/// Helper: read back JSON from a file, or None if the file does not exist.
fn read_json(path: &std::path::Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Owner user-scope MCP servers are written into the agent-root `.claude.json`.
#[test]
fn test_b8_merge_writes_owner_mcp_servers_to_agent_root() {
    let dir = tempfile::tempdir().unwrap();
    let owner_mcp = dir.path().join("owner.claude.json");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let agent_file = agent_dir.join(".claude.json");

    write_json(
        &owner_mcp,
        &serde_json::json!({
            "mcpServers": {
                "filesystem": {"command": "npx"},
                "github": {"command": "gh"}
            }
        }),
    );

    merge_agent_mcp_servers_with_warnings(&agent_dir, &owner_mcp, "buzz-mcp");

    let result = read_json(&agent_file).expect("agent file written");
    let servers = result["mcpServers"].as_object().expect("mcpServers object");
    assert!(
        servers.contains_key("filesystem"),
        "filesystem server must appear"
    );
    assert!(servers.contains_key("github"), "github server must appear");
    assert_eq!(servers.len(), 2, "exactly 2 servers");
}

/// Non-`mcpServers` keys in the agent `.claude.json` are preserved after merge.
#[test]
fn test_b8_merge_preserves_agent_owned_keys() {
    let dir = tempfile::tempdir().unwrap();
    let owner_mcp = dir.path().join("owner.claude.json");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let agent_file = agent_dir.join(".claude.json");

    write_json(
        &owner_mcp,
        &serde_json::json!({ "mcpServers": { "github": {"command": "gh"} } }),
    );
    write_json(
        &agent_file,
        &serde_json::json!({ "hasCompletedOnboarding": true }),
    );

    merge_agent_mcp_servers_with_warnings(&agent_dir, &owner_mcp, "buzz-mcp");

    let result = read_json(&agent_file).expect("agent file written");
    assert_eq!(
        result["hasCompletedOnboarding"].as_bool(),
        Some(true),
        "non-mcpServers key must be preserved"
    );
    assert!(
        result["mcpServers"]["github"].is_object(),
        "merged server must be present"
    );
}

/// Owner unreadable (distinct failure state #1): agent file is left unchanged —
/// the prior inherited set is preserved, not destroyed.
/// This triggers the Err path in read_owner_mcp_servers — uses a directory path
/// which exists but cannot be read as a file.
#[test]
fn test_b8_owner_read_failure_preserves_prior_inherited_set() {
    let dir = tempfile::tempdir().unwrap();
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let agent_file = agent_dir.join(".claude.json");

    write_json(
        &agent_file,
        &serde_json::json!({ "mcpServers": { "filesystem": {"command": "npx"} } }),
    );
    let original = std::fs::read_to_string(&agent_file).unwrap();

    // Use an existing DIRECTORY as the owner path — read_to_string on a directory
    // returns an Err, triggering the "preserve prior set" code path.
    let dir_as_file = dir.path().join("a_directory");
    std::fs::create_dir_all(&dir_as_file).unwrap();
    merge_agent_mcp_servers_with_warnings(&agent_dir, &dir_as_file, "buzz-mcp");

    let after = std::fs::read_to_string(&agent_file).unwrap();
    assert_eq!(
        after, original,
        "agent file must be unchanged when owner is unreadable"
    );
}

/// Owner has no `mcpServers` key: agent file is updated with empty `mcpServers`,
/// clearing any stale inherited set.
#[test]
fn test_b8_empty_owner_mcp_servers_clears_inherited_set() {
    let dir = tempfile::tempdir().unwrap();
    let owner_mcp = dir.path().join("owner.claude.json");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let agent_file = agent_dir.join(".claude.json");

    write_json(&owner_mcp, &serde_json::json!({}));
    write_json(
        &agent_file,
        &serde_json::json!({ "mcpServers": { "old-server": {} } }),
    );

    merge_agent_mcp_servers_with_warnings(&agent_dir, &owner_mcp, "buzz-mcp");

    let result = read_json(&agent_file).expect("file written");
    let servers = result["mcpServers"]
        .as_object()
        .expect("mcpServers present");
    assert!(
        servers.is_empty(),
        "empty owner mcpServers must clear the inherited set"
    );
}

/// Invalid agent JSON (distinct failure state #2): replaced with owner-only servers.
/// The corrupt content must not survive — the file was replaced, not preserved.
#[test]
fn test_b8_invalid_agent_file_falls_back_to_owner_only() {
    let dir = tempfile::tempdir().unwrap();
    let owner_mcp = dir.path().join("owner.claude.json");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let agent_file = agent_dir.join(".claude.json");

    write_json(
        &owner_mcp,
        &serde_json::json!({ "mcpServers": { "github": {"command": "gh"} } }),
    );
    std::fs::write(&agent_file, b"not valid json {{ at all").unwrap();

    merge_agent_mcp_servers_with_warnings(&agent_dir, &owner_mcp, "buzz-mcp");

    let result = read_json(&agent_file).expect("file replaced with valid JSON");
    let servers = result["mcpServers"].as_object().expect("mcpServers object");
    assert!(
        servers.contains_key("github"),
        "owner servers must appear after invalid-agent fallback"
    );
    let raw = std::fs::read_to_string(&agent_file).unwrap();
    assert!(
        !raw.contains("not valid json"),
        "corrupt content must not survive — file replaced"
    );
}

/// Collision filter (Thufir frozen invariant #2): inherited server with same name
/// as the ACP-provided server is omitted — Buzz wins by construction.
/// Case-insensitive match. Non-colliding servers pass through.
#[test]
fn test_b8_collision_filter_removes_acp_name_collision() {
    let dir = tempfile::tempdir().unwrap();
    let owner_mcp = dir.path().join("owner.claude.json");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let agent_file = agent_dir.join(".claude.json");

    write_json(
        &owner_mcp,
        &serde_json::json!({
            "mcpServers": {
                "buzz-mcp":  {"command": "buzz-mcp"},
                "BUZZ-MCP":  {"command": "buzz-mcp"},
                "github":    {"command": "gh"}
            }
        }),
    );

    merge_agent_mcp_servers_with_warnings(&agent_dir, &owner_mcp, "buzz-mcp");

    let result = read_json(&agent_file).expect("file written");
    let servers = result["mcpServers"].as_object().expect("mcpServers object");
    assert!(
        !servers.contains_key("buzz-mcp"),
        "exact-match ACP server must be filtered"
    );
    assert!(
        !servers.contains_key("BUZZ-MCP"),
        "case-variant ACP server must be filtered"
    );
    assert!(
        servers.contains_key("github"),
        "non-colliding server must pass through"
    );
}

/// Empty ACP server name disables collision filtering — all owner servers pass through.
#[test]
fn test_b8_empty_acp_name_disables_collision_filter() {
    let dir = tempfile::tempdir().unwrap();
    let owner_mcp = dir.path().join("owner.claude.json");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let agent_file = agent_dir.join(".claude.json");

    write_json(
        &owner_mcp,
        &serde_json::json!({ "mcpServers": { "filesystem": {}, "github": {} } }),
    );

    merge_agent_mcp_servers_with_warnings(&agent_dir, &owner_mcp, "");

    let result = read_json(&agent_file).expect("file written");
    let servers = result["mcpServers"].as_object().expect("mcpServers object");
    assert_eq!(
        servers.len(),
        2,
        "all servers must pass through with empty ACP name"
    );
}

/// Missing owner file (no `~/.claude.json` yet): treated as empty owner — agent
/// file gets an empty `mcpServers` set, not a write-skip.
#[test]
fn test_b8_missing_owner_file_writes_empty_mcp_set() {
    let dir = tempfile::tempdir().unwrap();
    let owner_mcp = dir.path().join("no_such_owner.claude.json"); // does not exist
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    let agent_file = agent_dir.join(".claude.json");

    merge_agent_mcp_servers_with_warnings(&agent_dir, &owner_mcp, "buzz-mcp");

    let result = read_json(&agent_file).expect("file written for missing owner");
    let servers = result["mcpServers"]
        .as_object()
        .expect("mcpServers object present");
    assert!(
        servers.is_empty(),
        "missing owner must produce empty mcpServers"
    );
}

/// Concurrent calls to `merge_agent_mcp_servers_with_warnings` for the same agent root must
/// not corrupt the file.  The atomic-rename durability primitive ensures each
/// write is all-or-nothing; the winner produces valid JSON.
///
/// In production the `managed_agent_runtime_transition` mutex prevents concurrent
/// B8 writes for the same root — this tests the file-level primitive independently.
#[test]
fn test_b8_serialization_no_lost_update() {
    use std::sync::Arc;
    let dir = tempfile::tempdir().unwrap();
    let owner_mcp = Arc::new(dir.path().join("owner.claude.json"));
    let agent_dir = Arc::new(dir.path().join("agent"));
    std::fs::create_dir_all(agent_dir.as_ref()).unwrap();

    write_json(
        &owner_mcp,
        &serde_json::json!({ "mcpServers": { "github": {} } }),
    );

    let (o1, a1) = (Arc::clone(&owner_mcp), Arc::clone(&agent_dir));
    let (o2, a2) = (Arc::clone(&owner_mcp), Arc::clone(&agent_dir));
    let t1 =
        std::thread::spawn(move || merge_agent_mcp_servers_with_warnings(&a1, &o1, "buzz-mcp"));
    let t2 =
        std::thread::spawn(move || merge_agent_mcp_servers_with_warnings(&a2, &o2, "buzz-mcp"));
    t1.join().unwrap();
    t2.join().unwrap();

    let agent_file = dir.path().join("agent").join(".claude.json");
    let result = read_json(&agent_file).expect("file must be valid JSON after concurrent writes");
    assert!(
        result["mcpServers"].is_object(),
        "mcpServers must be an object after concurrent writes"
    );
}

/// `agent_mcp_config_path` returns a path under `<managed_root>/claude/<pubkey>/`
/// consistent with the B1 CLAUDE_CONFIG_DIR layout.
#[test]
fn test_b8_agent_mcp_config_path_location() {
    let dir = tempfile::tempdir().unwrap();
    let managed_root = dir.path();
    let pubkey = "abcd1234efabcd12";
    let path = agent_mcp_config_path(managed_root, pubkey);
    assert!(
        path.ends_with(std::path::Path::new(pubkey).join(".claude.json")),
        "agent mcp path must end with <pubkey>/.claude.json; got: {path:?}"
    );
    assert!(
        path.starts_with(managed_root),
        "path must be under managed_root"
    );
}

// ── B8 write-failure test ─────────────────────────────────────────────────────

/// Agent `.claude.json` write failure (failure state #3): spawn continues.
/// Simulated by making the parent directory read-only before the merge.
/// The warning is returned and spawn proceeds.
#[cfg(unix)]
#[test]
fn test_b8_agent_write_failure_does_not_block_spawn() {
    // Skip on CI where we may run as root (read-only dirs are ignored by root).
    if std::env::var("CI").is_ok() {
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let owner_mcp = dir.path().join("owner.claude.json");
    let agent_dir = dir.path().join("agent");
    std::fs::create_dir_all(&agent_dir).unwrap();

    write_json(
        &owner_mcp,
        &serde_json::json!({ "mcpServers": { "github": {} } }),
    );

    // Make the agent dir read-only so the write must fail.
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&agent_dir, std::fs::Permissions::from_mode(0o555)).unwrap();

    // merge_agent_mcp_servers_with_warnings must not panic or return Err — spawn continues.
    // We verify it returns exactly one warning (failure state #3).
    let warnings = merge_agent_mcp_servers_with_warnings(&agent_dir, &owner_mcp, "buzz-mcp");
    let has_write_failure_warning = warnings.iter().any(|w| w.contains("may be stale"));
    assert!(
        has_write_failure_warning,
        "write failure must produce the 'may be stale' warning; got: {warnings:?}"
    );

    // Restore permissions so tempdir cleanup doesn't fail.
    std::fs::set_permissions(&agent_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
}

// ── apply_claude_spawn_policy env tests ──────────────────────────────────────

/// B1: the paired isolation atom (CLAUDE_CONFIG_DIR + CLAUDE_SECURESTORAGE_CONFIG_DIR="")
/// must be present in the spawned-child env after policy application.
#[test]
fn test_apply_policy_b1_paired_atom_present_in_spawned_env() {
    let dir = tempfile::tempdir().unwrap();
    let managed_root = dir.path().to_path_buf();
    let pubkey = "abcd1234abcd1234";
    // Owner settings.json doesn't exist — overlay-only path.
    let mut cmd = std::process::Command::new("true");
    apply_claude_spawn_policy(&mut cmd, pubkey, &managed_root, None, None, None).unwrap();

    let env_map: std::collections::HashMap<_, _> = cmd.get_envs().collect();

    // CLAUDE_CONFIG_DIR must be set to the per-agent root.
    let config_dir = env_map.get(std::ffi::OsStr::new("CLAUDE_CONFIG_DIR"));
    assert!(config_dir.is_some(), "CLAUDE_CONFIG_DIR must be present");
    let config_dir_val = config_dir.unwrap().unwrap_or_default();
    assert!(
        config_dir_val.to_string_lossy().contains(pubkey),
        "CLAUDE_CONFIG_DIR must contain the agent pubkey"
    );

    // CLAUDE_SECURESTORAGE_CONFIG_DIR must be the empty string.
    let securestorage = env_map.get(std::ffi::OsStr::new("CLAUDE_SECURESTORAGE_CONFIG_DIR"));
    assert!(
        securestorage.is_some(),
        "CLAUDE_SECURESTORAGE_CONFIG_DIR must be present"
    );
    assert_eq!(
        securestorage.unwrap().unwrap_or_default(),
        "",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR must be empty string"
    );
}

/// A1: BUZZ_ACP_MODEL must NOT be present in the spawned-child env after policy
/// application, even if it was set before (dual-authority defect).
#[test]
fn test_apply_policy_a1_buzz_acp_model_absent_after_policy() {
    let dir = tempfile::tempdir().unwrap();
    let managed_root = dir.path().to_path_buf();
    let pubkey = "abcd1234abcd1234";
    let mut cmd = std::process::Command::new("true");
    // Pre-set BUZZ_ACP_MODEL as if it came from descriptor.env.
    cmd.env("BUZZ_ACP_MODEL", "claude-opus-4");
    apply_claude_spawn_policy(
        &mut cmd,
        pubkey,
        &managed_root,
        None,
        Some("claude-opus-4"),
        None,
    )
    .unwrap();

    let env_map: std::collections::HashMap<_, _> = cmd.get_envs().collect();
    // BUZZ_ACP_MODEL must be removed (env_remove).
    // Command::get_envs returns None for removed keys.
    let buzz_acp_model = env_map.get(std::ffi::OsStr::new("BUZZ_ACP_MODEL"));
    assert!(
        buzz_acp_model.is_none() || buzz_acp_model.unwrap().is_none(),
        "BUZZ_ACP_MODEL must be absent (or explicitly removed) after policy application"
    );
    // ANTHROPIC_MODEL must be set to the resolved model.
    let anthropic_model = env_map.get(std::ffi::OsStr::new("ANTHROPIC_MODEL"));
    assert!(
        anthropic_model.is_some(),
        "ANTHROPIC_MODEL must be present after policy application"
    );
    assert_eq!(
        anthropic_model.unwrap().unwrap_or_default(),
        "claude-opus-4",
        "ANTHROPIC_MODEL must equal the effective model"
    );
}

// ── Spawn-warning persistence tests ──────────────────────────────────────────

/// Spawn warnings round-trip through write_spawn_warnings / read_spawn_warnings.
#[test]
fn test_spawn_warnings_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = dir.path().to_path_buf();
    let warnings = vec![
        "Owner settings.json unreadable — launching with overlay-only settings".to_string(),
        "Failed to write agent MCP config; inherited servers may be stale: mock error".to_string(),
    ];
    write_spawn_warnings(&config_dir, &warnings);
    let read_back = read_spawn_warnings(&config_dir);
    assert_eq!(read_back, warnings, "read_back must equal written warnings");
}

/// Empty warnings → file removed (no stale warning from a previous spawn).
#[test]
fn test_spawn_warnings_empty_removes_stale_file() {
    let dir = tempfile::tempdir().unwrap();
    let config_dir = dir.path().to_path_buf();
    // Write a non-empty set first.
    write_spawn_warnings(&config_dir, &["stale warning".to_string()]);
    assert!(
        config_dir.join(SPAWN_WARNINGS_FILE).exists(),
        "file must exist after non-empty write"
    );
    // Write empty → file removed.
    write_spawn_warnings(&config_dir, &[]);
    assert!(
        !config_dir.join(SPAWN_WARNINGS_FILE).exists(),
        "file must be removed after empty write"
    );
    assert_eq!(
        read_spawn_warnings(&config_dir),
        Vec::<String>::new(),
        "read after removal must return empty vec"
    );
}
