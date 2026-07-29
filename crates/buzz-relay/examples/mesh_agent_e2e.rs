//! End-to-end mesh + agent permutation harness — fully headless, no desktop
//! app, no keychain. Proves the whole chain the UI exercises:
//!
//!   share compute (serve node) → agent env preset → ACP agent → inference
//!
//! Permutations:
//!   P1 explicit-model chat  — agent pinned to the served model id replies.
//!   P2 auto-model chat      — agent sends `model: "auto"`; mesh router picks.
//!   P3 context-fit regression — an oversized output budget (150k tokens)
//!      must FAIL with the router's context error (proves the router's fit
//!      gate — the failure mode the 4096 preset cap protects against).
//!   P4 agentic tool use     — agent + buzz-dev-mcp writes a file on disk.
//!   P5 Buzz reply command   — agent asks the real developer MCP to run the
//!      exact `buzz messages send` command used to publish a reply. A fake
//!      shell records the command at the execution boundary, so this proves
//!      the model emits the right command but NOT that a reply lands.
//!   P6 live relay send      — the genuine `buzz messages send` (dev-mcp's
//!      multicall shim, real buzz-cli) against a running relay. The harness
//!      then queries the relay itself: the agent's prose is not evidence.
//!      Skipped unless the live-relay env vars below are set.
//!
//! The serve node is the same `mesh_llm_sdk::serve` path Share-compute uses
//! (publish off, mdns, loopback). The agent legs spawn the real
//! `buzz-agent` binary with the exact env vars the relay-mesh preset ships.
//!
//! Hardware-gated, not CI. Run:
//!   cargo build --release -p buzz-agent -p buzz-dev-mcp -p buzz-cli
//!   cargo run -p buzz-relay --example mesh_agent_e2e
//! Env: MESH_E2E_MODEL overrides the served model ref.
//!
//! P6 additionally needs a relay (`just relay` — Postgres + Redis) plus:
//!   BUZZ_E2E_RELAY_URL=ws://localhost:3000
//!   BUZZ_E2E_PRIVATE_KEY=<hex identity that may post to the channel>
//!   BUZZ_E2E_CHANNEL=<channel uuid>
//! All three must be set or P6 is skipped (P1-P5 still run).
use std::process::Stdio;
use std::time::Duration;

use mesh_llm_sdk::{serve, MeshDiscoveryMode};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

// Non-reasoning Gemma 4 is the small Buzz-curated default. It reaches tool
// calls promptly instead of spending the output budget in a hidden reasoning
// loop. MESH_E2E_MODEL can still exercise any other served model explicitly.
const DEFAULT_MODEL: &str = "unsloth/gemma-4-E4B-it-GGUF:Q4_K_M";
const API_PORT: u16 = 19437;
const CONSOLE_PORT: u16 = 13231;

#[derive(Clone)]
struct McpServerEnv {
    name: String,
    value: String,
}

#[derive(Clone)]
struct McpServerSpec {
    name: String,
    command: String,
    env: Vec<McpServerEnv>,
}

impl McpServerSpec {
    fn new(name: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            command: command.into(),
            env: Vec::new(),
        }
    }

    fn set_env(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.env.push(McpServerEnv {
            name: name.into(),
            value: value.into(),
        });
    }
}

fn main() -> anyhow::Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        // Same fix the desktop ships: mesh-llm futures need >2MiB stacks.
        .thread_stack_size(8 * 1024 * 1024)
        .build()?
        .block_on(run())
}

async fn run() -> anyhow::Result<()> {
    let model = std::env::var("MESH_E2E_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
    mesh_llm_host_runtime::initialize_host_runtime()
        .await
        .map_err(|e| anyhow::anyhow!("host runtime init: {e}"))?;

    eprintln!("[e2e] starting serve node with {model} (loading may take a minute)...");
    let cfg = serve::EmbeddedServeConfig::builder()
        .model(&model)
        .api_port(API_PORT)
        .console_port(CONSOLE_PORT)
        .publish(false)
        .auto_join(false)
        .discovery_mode(MeshDiscoveryMode::Mdns)
        .console_ui(true) // readiness poll needs the console bound
        .startup_timeout(Duration::from_secs(300))
        .build();
    let node = serve::start(cfg)
        .await
        .map_err(|e| anyhow::anyhow!("serve start: {e}"))?;
    let base = node.api_base_url().to_string();

    // Wait for the model to be loaded + resolvable, capture its served id.
    let http = reqwest::Client::new();
    let mut served_id = String::new();
    for _ in 0..120 {
        if let Ok(resp) = http.get(format!("{base}/models")).send().await {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(id) = json["data"].get(0).and_then(|m| m["id"].as_str()) {
                    served_id = id.to_string();
                    break;
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    anyhow::ensure!(!served_id.is_empty(), "model never appeared in /models");
    eprintln!("[e2e] node up, served id = {served_id}");

    let mut pass = 0usize;
    let mut fail = 0usize;
    let mut record = |name: &str, ok: bool, detail: String| {
        if ok {
            pass += 1;
            eprintln!("[e2e] PASS {name}: {detail}");
        } else {
            fail += 1;
            eprintln!("[e2e] FAIL {name}: {detail}");
        }
    };

    // P1: explicit model id.
    let r = agent_chat(
        &base,
        &served_id,
        None,
        "Reply with exactly one word: PONG",
        &[],
    )
    .await;
    match r {
        Ok(text) => record(
            "P1 explicit-model chat",
            text.to_uppercase().contains("PONG"),
            text,
        ),
        Err(e) => record("P1 explicit-model chat", false, e.to_string()),
    }

    // P2: auto — router picks the model.
    let r = agent_chat(
        &base,
        "auto",
        None,
        "Reply with exactly one word: PONG",
        &[],
    )
    .await;
    match r {
        Ok(text) => record(
            "P2 auto-model chat",
            text.to_uppercase().contains("PONG"),
            text,
        ),
        Err(e) => record("P2 auto-model chat", false, e.to_string()),
    }

    // P3: regression — an output budget no served model's context can hold
    // must be rejected by the router with the context-fit error (the failure
    // mode that broke relay-mesh agents when buzz-agent's default 32768
    // budget met a 32k-context model). 150k output: passes buzz-agent's own
    // config validation (must stay under its 200k max_context_tokens) but
    // with the router's +25% margin overflows even 128k-context models like
    // GLM-4.7-Flash.
    let r = agent_chat(
        &base,
        &served_id,
        Some("150000"),
        "Reply with exactly one word: PONG",
        &[],
    )
    .await;
    match r {
        Ok(text) => record(
            "P3 oversized-budget must fail",
            false,
            format!("unexpectedly succeeded: {text}"),
        ),
        Err(e) => {
            let msg = e.to_string();
            let is_context_503 = msg.contains("503")
                || msg.contains("service_unavailable")
                || msg.contains("context-compatible");
            record("P3 oversized-budget must fail", is_context_503, msg);
        }
    }

    // P4: agentic tool use via buzz-dev-mcp — write a real file inside the
    // isolated ACP working directory. The MCP sandbox intentionally rejects
    // nonexistent absolute paths outside that root.
    let marker_name = format!("mesh-e2e-{}.txt", std::process::id());
    let prompt = format!(
        "Use your developer tools to create {marker_name} in the current working directory containing exactly the text BUZZ_OK (no quotes, no newline commentary). Then confirm."
    );
    let mcp = vec![McpServerSpec::new("dev", repo_bin("buzz-dev-mcp")?)];
    let (r, marker) =
        agent_chat_with_marker(&base, &served_id, None, &prompt, &mcp, &marker_name).await;
    let file_ok = std::fs::read_to_string(&marker)
        .map(|c| c.contains("BUZZ_OK"))
        .unwrap_or(false);
    match r {
        Ok(text) => record(
            "P4 agentic tool use",
            file_ok,
            if file_ok {
                format!("file written; agent said: {text}")
            } else {
                format!("no file at {}; agent said: {text}", marker.display())
            },
        ),
        Err(e) => record("P4 agentic tool use", file_ok, format!("agent error: {e}")),
    }
    let _ = std::fs::remove_file(&marker);

    // P5: prove the model follows Buzz's real reply path. buzz-dev-mcp always
    // prepends its own multicall `buzz` shim to PATH, so a fake `buzz` later on
    // PATH cannot isolate this test. Instead, inject a fake shell into the real
    // MCP server. It records the exact command at the execution boundary and
    // returns the same accepted-write shape as buzz-cli, without contacting a
    // community.
    let send_marker = format!("mesh-e2e-buzz-send-{}.txt", std::process::id());
    let prompt = "Use the developer shell tool to run exactly this command: buzz messages send --channel test-channel --content BUZZ_REPLY_OK. Do not simulate or substitute another command. After it succeeds, confirm briefly.";
    let (r, marker) =
        agent_chat_with_fake_shell(&base, &served_id, prompt, &mcp, &send_marker).await;
    let recorded = std::fs::read_to_string(&marker).unwrap_or_default();
    // The fake shell appends every command it is handed. Small models often
    // probe with an unrelated command first, so the pass condition is that the
    // exact Buzz send reached the execution boundary on some line — not that it
    // was the only command attempted.
    const EXPECTED_SEND: &str = "buzz messages send --channel test-channel --content BUZZ_REPLY_OK";
    let attempts: Vec<&str> = recorded
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let send_ok = attempts.contains(&EXPECTED_SEND);
    match r {
        Ok(text) => record(
            "P5 Buzz reply command",
            send_ok,
            format!("commands attempted {attempts:?}; agent said: {text}"),
        ),
        Err(e) => record(
            "P5 Buzz reply command",
            send_ok,
            format!("agent error: {e}; commands attempted: {attempts:?}"),
        ),
    }
    let _ = std::fs::remove_file(&marker);

    // P6: live relay end-to-end. P5 stops at the shell boundary with a fake
    // shell, so it cannot prove a reply ever reaches a channel. Here the agent
    // runs the genuine `buzz messages send` (dev-mcp's multicall shim, real
    // buzz-cli code) against a running relay, and the harness independently
    // queries the relay afterwards rather than trusting the agent's prose.
    //
    // Infra-gated: needs `just relay` (Postgres + Redis) and an identity:
    //   BUZZ_E2E_RELAY_URL, BUZZ_E2E_PRIVATE_KEY, BUZZ_E2E_CHANNEL
    match (
        std::env::var("BUZZ_E2E_RELAY_URL").ok(),
        std::env::var("BUZZ_E2E_PRIVATE_KEY").ok(),
        std::env::var("BUZZ_E2E_CHANNEL").ok(),
    ) {
        (Some(relay_url), Some(private_key), Some(channel)) => {
            let live_marker = format!("BUZZ_LIVE_OK_{}", std::process::id());
            let mut dev = McpServerSpec::new("dev", repo_bin("buzz-dev-mcp")?);
            dev.set_env("BUZZ_RELAY_URL", relay_url.as_str());
            dev.set_env("BUZZ_PRIVATE_KEY", private_key.as_str());
            let prompt = format!(
                "You are a Buzz agent with shell access. The `buzz` CLI is on your PATH; `buzz messages send` publishes to a channel. Post a message containing exactly the token {live_marker} to channel {channel}."
            );
            let r = agent_chat(&base, &served_id, None, &prompt, &[dev]).await;
            let landed = relay_has_message(&relay_url, &private_key, &channel, &live_marker).await;
            let landed_ok = matches!(landed, Ok(true));
            let detail = match (&r, &landed) {
                (Ok(text), Ok(true)) => {
                    format!("relay returned {live_marker}; agent said: {text}")
                }
                (Ok(text), Ok(false)) => {
                    format!("{live_marker} never reached the relay; agent said: {text}")
                }
                (Ok(text), Err(e)) => format!("relay verification failed: {e}; agent said: {text}"),
                (Err(e), _) => format!("agent error: {e}"),
            };
            record("P6 live relay send", landed_ok, detail);
        }
        _ => eprintln!(
            "[e2e] SKIP P6 live relay send (set BUZZ_E2E_RELAY_URL, BUZZ_E2E_PRIVATE_KEY, BUZZ_E2E_CHANNEL)"
        ),
    }

    eprintln!("[e2e] {pass} passed, {fail} failed");
    if fail > 0 {
        eprintln!("[e2e] FAIL: {fail} permutation(s) failed");
        exit_without_native_destructors(1);
    }
    eprintln!("[e2e] PASS: share-compute → agent → inference proven end to end");
    exit_without_native_destructors(0);
}

/// Replace the process image so libc does not run llama.cpp's crashing Metal
/// `atexit` handlers (mesh-console issue #8). `std::process::exit` is not enough:
/// it skips Rust drops but still runs native C/C++ finalizers.
fn exit_without_native_destructors(code: i32) -> ! {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let program = if code == 0 { "true" } else { "false" };
        let error = std::process::Command::new(program).exec();
        eprintln!("[e2e] failed to exec {program}: {error}");
    }
    std::process::exit(code)
}

fn repo_bin(name: &str) -> anyhow::Result<String> {
    let path = std::env::current_dir()?.join("target/release").join(name);
    anyhow::ensure!(
        path.exists(),
        "{} missing — cargo build --release -p {name}",
        path.display()
    );
    Ok(path.to_string_lossy().into_owned())
}

/// Ask the relay directly whether `marker` is present in `channel`.
///
/// This is the independent check that makes P6 meaningful: the agent's prose is
/// not evidence, and neither is the shell exit code. The harness performs its
/// own authenticated read against the relay in a separate process and only
/// trusts what comes back. Polls because the relay persists and fans out
/// asynchronously, so an immediate read can race the write.
async fn relay_has_message(
    relay_url: &str,
    private_key: &str,
    channel: &str,
    marker: &str,
) -> anyhow::Result<bool> {
    let buzz = repo_bin("buzz")?;
    for _ in 0..15 {
        let output = Command::new(&buzz)
            .args([
                "--format",
                "compact",
                "messages",
                "get",
                "--channel",
                channel,
                "--limit",
                "50",
            ])
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("BUZZ_RELAY_URL", relay_url)
            .env("BUZZ_PRIVATE_KEY", private_key)
            .output()
            .await?;
        if output.status.success() && String::from_utf8_lossy(&output.stdout).contains(marker) {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    Ok(false)
}

/// Spawn the real buzz-agent with relay-mesh preset env and drive one ACP
/// session/prompt over stdio. Returns the concatenated agent message text,
/// or Err carrying the agent's error message.
async fn agent_chat(
    base: &str,
    model: &str,
    max_output_tokens: Option<&str>,
    prompt: &str,
    mcp_servers: &[McpServerSpec],
) -> anyhow::Result<String> {
    let (result, _) =
        agent_chat_in_isolated_home(base, model, max_output_tokens, prompt, mcp_servers, None)
            .await;
    result
}

async fn agent_chat_with_marker(
    base: &str,
    model: &str,
    max_output_tokens: Option<&str>,
    prompt: &str,
    mcp_servers: &[McpServerSpec],
    marker_name: &str,
) -> (anyhow::Result<String>, std::path::PathBuf) {
    let (result, home) =
        agent_chat_in_isolated_home(base, model, max_output_tokens, prompt, mcp_servers, None)
            .await;
    (result, home.join(marker_name))
}

async fn agent_chat_with_fake_shell(
    base: &str,
    model: &str,
    prompt: &str,
    mcp_servers: &[McpServerSpec],
    marker_name: &str,
) -> (anyhow::Result<String>, std::path::PathBuf) {
    let (result, home) =
        agent_chat_in_isolated_home(base, model, None, prompt, mcp_servers, Some(marker_name))
            .await;
    (result, home.join(marker_name))
}

async fn agent_chat_in_isolated_home(
    base: &str,
    model: &str,
    max_output_tokens: Option<&str>,
    prompt: &str,
    mcp_servers: &[McpServerSpec],
    fake_shell_marker_name: Option<&str>,
) -> (anyhow::Result<String>, std::path::PathBuf) {
    let agent = match repo_bin("buzz-agent") {
        Ok(agent) => agent,
        Err(error) => return (Err(error), std::path::PathBuf::new()),
    };
    // Isolated HOME: no skills, no AGENTS.md chain, no keychain, tiny prompt.
    let home = std::env::temp_dir().join(format!("mesh-e2e-home-{}", std::process::id()));
    if let Err(error) = std::fs::create_dir_all(&home) {
        return (Err(error.into()), home);
    }

    let child_path = std::env::var("PATH").unwrap_or_default();
    let mut effective_mcp_servers = mcp_servers.to_vec();
    if let Some(marker_name) = fake_shell_marker_name {
        let fake_shell = match install_fake_shell(&home) {
            Ok(fake_shell) => fake_shell,
            Err(error) => return (Err(error), home),
        };
        let marker = home.join(marker_name);
        let Some(dev_server) = effective_mcp_servers
            .iter_mut()
            .find(|server| server.name == "dev")
        else {
            return (Err(anyhow::anyhow!("P5 requires the dev MCP server")), home);
        };
        dev_server.set_env("BUZZ_SHELL", fake_shell.to_string_lossy());
        dev_server.set_env("BUZZ_E2E_SEND_MARKER", marker.to_string_lossy());
    }

    let mut command = Command::new(&agent);
    command
        .env_clear()
        .env("PATH", child_path)
        .env("HOME", &home)
        // Exactly the environment apply_relay_mesh_env() supplies.
        .env("BUZZ_AGENT_PROVIDER", "openai")
        .env("BUZZ_AGENT_MODEL", model)
        .env("OPENAI_COMPAT_BASE_URL", base)
        .env("OPENAI_COMPAT_MODEL", model)
        .env("OPENAI_COMPAT_API_KEY", "buzz-mesh-local")
        .env("OPENAI_COMPAT_API", "chat")
        .env("BUZZ_AGENT_MAX_OUTPUT_TOKENS", "4096")
        // Must track apply_relay_mesh_env()'s default. `none` suppresses tool
        // calling on local models, so pinning it here would test a config the
        // product no longer ships and hide the very regression P5/P6 exist for.
        .env("BUZZ_AGENT_THINKING_EFFORT", "low")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // P3 deliberately overrides the production default to exercise the
    // router's context-fit rejection. Normal and tool turns leave it unset,
    // matching the desktop provider path.
    if let Some(value) = max_output_tokens {
        command.env("BUZZ_AGENT_MAX_OUTPUT_TOKENS", value);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return (Err(error.into()), home),
    };

    let result = drive_acp(&mut child, prompt, &effective_mcp_servers, &home).await;
    let _ = child.kill().await;
    (result, home)
}

#[cfg(unix)]
fn install_fake_shell(home: &std::path::Path) -> anyhow::Result<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    let bin_dir = home.join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    let executable = bin_dir.join("mesh-e2e-shell");
    // buzz-dev-mcp spawns `<shell> -c "<command>"` on Unix (`shell_flag()`
    // returns `-c` for every non-cmd/pwsh shell). Accept `-lc` too so a future
    // login-shell dialect change does not silently stop recording.
    // Every command is appended, one per line: a small model often probes with
    // an unrelated command first, and overwriting would discard the real send.
    std::fs::write(
        &executable,
        r#"#!/bin/sh
case "$1" in
  -c|-lc) command_string="$2" ;;
  *)
    printf 'unsupported fake shell invocation: %s\n' "$*" >&2
    exit 2
    ;;
esac
printf '%s\n' "$command_string" >> "$BUZZ_E2E_SEND_MARKER"
if [ "$command_string" = "buzz messages send --channel test-channel --content BUZZ_REPLY_OK" ]; then
  printf '%s\n' '{"event_id":"mesh-e2e-event","accepted":true,"message":"ok"}'
  exit 0
fi
printf 'unsupported fake shell command: %s\n' "$command_string" >&2
exit 2
"#,
    )?;
    let mut permissions = std::fs::metadata(&executable)?.permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&executable, permissions)?;
    // BUZZ_SHELL must name the executable itself. Returning the directory made
    // `resolve_bash()` reject it as "not a file" and fall back to real bash, so
    // the fake shell never ran and P5 could never record a command.
    Ok(executable)
}

#[cfg(not(unix))]
fn install_fake_shell(_home: &std::path::Path) -> anyhow::Result<std::path::PathBuf> {
    anyhow::bail!("the mesh agent hardware harness currently requires Unix")
}

/// The real Buzz system prompt every managed agent receives, straight from the
/// harness crate rather than a paraphrase.
///
/// A terse hand-written test prompt is not a proxy for this: it is ~3.2k tokens
/// of instructions, and the reply-delivery rules the model must follow to get a
/// message into a channel live in here. Testing with a short prompt measures a
/// toy, not Buzz.
const BUZZ_BASE_PROMPT: &str = include_str!("../../buzz-acp/src/base_prompt.md");

async fn drive_acp(
    child: &mut Child,
    prompt: &str,
    mcp_servers: &[McpServerSpec],
    cwd: &std::path::Path,
) -> anyhow::Result<String> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdin"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("no stdout"))?;
    let mut lines = BufReader::new(stdout).lines();

    let mcp_json: Vec<serde_json::Value> = mcp_servers
        .iter()
        .map(|server| {
            let env: Vec<serde_json::Value> = server
                .env
                .iter()
                .map(|entry| serde_json::json!({ "name": &entry.name, "value": &entry.value }))
                .collect();
            serde_json::json!({
                "name": &server.name,
                "command": &server.command,
                "args": [],
                "env": env,
            })
        })
        .collect();

    let send = |v: serde_json::Value| format!("{v}\n");
    stdin
        .write_all(
            send(serde_json::json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": 1, "clientCapabilities": {} }
            }))
            .as_bytes(),
        )
        .await?;
    stdin
        .write_all(
            send(serde_json::json!({
                "jsonrpc": "2.0", "id": 2, "method": "session/new",
                "params": {
                    "cwd": cwd.to_string_lossy(),
                    "mcpServers": mcp_json,
                    "systemPrompt": BUZZ_BASE_PROMPT
                }
            }))
            .as_bytes(),
        )
        .await?;

    let mut session_id: Option<String> = None;
    let mut agent_text = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);

    loop {
        let line = tokio::time::timeout_at(deadline, lines.next_line())
            .await
            .map_err(|_| anyhow::anyhow!("agent timed out; text so far: {agent_text}"))??
            .ok_or_else(|| anyhow::anyhow!("agent closed stdout; text so far: {agent_text}"))?;
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        // Collect any streamed agent text from session/update notifications.
        if msg.get("method").and_then(|m| m.as_str()) == Some("session/update") {
            collect_text(&msg["params"]["update"], &mut agent_text);
            continue;
        }
        match msg.get("id").and_then(|i| i.as_i64()) {
            Some(2) => {
                if let Some(err) = msg.get("error") {
                    anyhow::bail!("session/new failed: {err}");
                }
                let sid = msg["result"]["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("session/new: no sessionId: {msg}"))?
                    .to_string();
                stdin
                    .write_all(
                        send(serde_json::json!({
                            "jsonrpc": "2.0", "id": 3, "method": "session/prompt",
                            "params": {
                                "sessionId": sid,
                                "prompt": [ { "type": "text", "text": prompt } ]
                            }
                        }))
                        .as_bytes(),
                    )
                    .await?;
                session_id = Some(sid);
            }
            Some(3) => {
                anyhow::ensure!(session_id.is_some(), "prompt response before session");
                if let Some(err) = msg.get("error") {
                    anyhow::bail!("session/prompt failed: {err}");
                }
                return Ok(agent_text.trim().to_string());
            }
            _ => {}
        }
    }
}

/// Recursively harvest "text" string fields out of a session/update payload.
fn collect_text(value: &serde_json::Value, out: &mut String) {
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if k == "text" {
                    if let Some(s) = v.as_str() {
                        out.push_str(s);
                    }
                } else {
                    collect_text(v, out);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_text(item, out);
            }
        }
        _ => {}
    }
}
