//! The turn driver: Goose's agent loop, translated onto buzz-agent's ACP wire.
//!
//! This replaces roughly 8,000 lines of `crates/buzz-agent`:
//!
//! | buzz-agent file | lines | who owns it now |
//! |---|---:|---|
//! | `llm.rs`      | 3846 | `goose::providers` (superset of the 4 providers) |
//! | `mcp.rs`      | 1139 | `goose::agents::extension_manager` |
//! | `auth.rs`     |  845 | `goose::providers` (incl. Databricks OAuth) |
//! | `agent.rs`    |  746 | `goose::agents::Agent::reply` |
//! | `hints.rs`    |  726 | `goose`'s hint loader (`prompt_manager::with_hints`) |
//! | `catalog.rs`  |  631 | `goose::providers::init` model discovery |
//! | `builtin.rs`  |  575 | `goose`'s `skills` platform extension |
//! | `handoff.rs`  |  430 | `goose::context_mgmt` (auto-compaction) |
//!
//! What this file keeps is the part Goose does *not* know about: the mapping
//! from `AgentEvent` onto the exact `session/update` notifications `buzz-acp`
//! consumes (`acp.rs:1528-1627`), and the `keepalive` ticker that resets the
//! harness idle clock.

use std::sync::Arc;

use futures::StreamExt;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use goose::agents::{Agent, AgentEvent, SessionConfig};
use goose_provider_types::conversation::message::{Message, MessageContent};

use crate::types::{AgentError, ContentBlock, StopReason};
use crate::wire::{self, WireSender};

/// How often to emit `keepalive` while waiting on the provider.
///
/// NOT part of ACP. `buzz-acp` runs an idle-timeout clock that is reset on
/// every line of valid JSON (`acp.rs:1197-1199`); a silent agent is killed.
/// buzz-agent emitted this from inside its provider `select!`
/// (`agent.rs:122-127`) and `buzz-acp` treats it as a no-op that only resets
/// the clock (`acp.rs:1623`).
///
/// Goose streams, so during generation the chunks themselves keep the clock
/// alive — but there is no traffic during a long *pre-first-token* wait (big
/// prompt processing, provider queueing, reasoning models). So the ticker
/// stays.
const KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Per-turn token accounting, mirroring buzz-agent's contract.
#[derive(Debug, Default, Clone, Copy)]
pub struct TurnTokens {
    pub input: Option<u64>,
    pub output: Option<u64>,
}

impl TurnTokens {
    pub fn observed(&self) -> bool {
        self.input.is_some() || self.output.is_some()
    }
}

/// Flatten ACP prompt blocks into the text Goose's `Message` carries.
pub fn prompt_to_text(blocks: &[ContentBlock]) -> String {
    let mut out = String::new();
    for b in blocks {
        match b {
            ContentBlock::Text { text } => {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
            ContentBlock::ResourceLink { uri } => {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(uri);
            }
            ContentBlock::Unsupported => {}
        }
    }
    out
}

/// Drive one `session/prompt` turn to completion.
///
/// Returns the ACP stop reason plus the turn's token counts. The caller is
/// responsible for emitting `usage_update` *before* the `session/prompt`
/// response — that ordering is load-bearing for kind-44200 metrics
/// (`buzz-agent/src/lib.rs:701-706`).
#[allow(clippy::too_many_arguments)]
pub async fn run_turn(
    agent: Arc<Agent>,
    session_id: &str,
    prompt: Vec<ContentBlock>,
    max_rounds: Option<u32>,
    wire_tx: &WireSender,
    cancel: CancellationToken,
) -> (Result<StopReason, AgentError>, TurnTokens) {
    let text = prompt_to_text(&prompt);
    let mut tokens = TurnTokens::default();

    let session_config = SessionConfig {
        id: session_id.to_string(),
        schedule_id: None,
        max_turns: max_rounds,
        retry_config: None,
    };

    let mut stream = match agent
        .reply(
            Message::user().with_text(text),
            session_config,
            Some(cancel.clone()),
        )
        .await
    {
        Ok(s) => s,
        Err(e) => return (Err(AgentError::Llm(e.to_string())), tokens),
    };

    let mut keepalive = tokio::time::interval(KEEPALIVE_INTERVAL);
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    keepalive.tick().await; // first tick is immediate; discard it

    let mut stop = StopReason::EndTurn;

    loop {
        tokio::select! {
            // Keep the harness idle clock alive during provider silence.
            _ = keepalive.tick() => {
                wire::send(
                    wire_tx,
                    wire::session_update(session_id, json!({ "sessionUpdate": "keepalive" })),
                )
                .await;
            }

            _ = cancel.cancelled() => {
                stop = StopReason::Cancelled;
                break;
            }

            next = stream.next() => {
                let Some(event) = next else { break };
                match event {
                    Ok(ev) => {
                        if let Some(reason) = handle_event(ev, session_id, wire_tx, &mut tokens).await {
                            stop = reason;
                            break;
                        }
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        // Preserve buzz-agent's error taxonomy so the harness's
                        // JSON-RPC code mapping stays meaningful.
                        let err = if msg.contains("auth") || msg.contains("401") {
                            AgentError::LlmAuth(msg)
                        } else if msg.contains("model") && msg.contains("not found") {
                            AgentError::LlmModelNotFound(msg)
                        } else {
                            AgentError::Llm(msg)
                        };
                        return (Err(err), tokens);
                    }
                }
            }
        }
    }

    if cancel.is_cancelled() {
        stop = StopReason::Cancelled;
    }

    (Ok(stop), tokens)
}

/// Translate one `AgentEvent` into ACP notifications.
///
/// Returns `Some(StopReason)` if the event terminates the turn.
async fn handle_event(
    event: AgentEvent,
    session_id: &str,
    wire_tx: &WireSender,
    tokens: &mut TurnTokens,
) -> Option<StopReason> {
    match event {
        AgentEvent::Message(msg) => {
            for content in &msg.content {
                emit_content(content, session_id, wire_tx).await;
            }
            None
        }

        // Usage arrives per provider chunk, already cost-enriched. Accumulate
        // rather than overwrite: `MessageUsage` is suppressed when the last
        // assistant message has no user-visible content (goose
        // `agent.rs:299`), so it is not a reliable sole source.
        AgentEvent::Usage(usage) => {
            let u = &usage.usage;
            if let Some(i) = u.input_tokens {
                tokens.input = Some(tokens.input.unwrap_or(0) + i.max(0) as u64);
            }
            if let Some(o) = u.output_tokens {
                tokens.output = Some(tokens.output.unwrap_or(0) + o.max(0) as u64);
            }
            None
        }

        // Compaction happened. buzz-agent surfaced this as a `[Context
        // Handoff]` history rewrite; here Goose has already done it and we
        // only need to note it.
        AgentEvent::HistoryReplaced(_) => {
            tracing::info!(target: "buzz_agent::compaction", "history compacted");
            None
        }

        _ => None,
    }
}

/// Map message content onto the nine `sessionUpdate` variants `buzz-acp`
/// recognises (`acp.rs:1528-1627`). Anything else it debug-logs and drops.
async fn emit_content(content: &MessageContent, session_id: &str, wire_tx: &WireSender) {
    match content {
        MessageContent::Text(t) if !t.text.is_empty() => {
            wire::send(
                wire_tx,
                wire::session_update(
                    session_id,
                    json!({
                        "sessionUpdate": "agent_message_chunk",
                        "content": { "type": "text", "text": t.text },
                    }),
                ),
            )
            .await;
        }

        MessageContent::Thinking(t) if !t.thinking.is_empty() => {
            wire::send(
                wire_tx,
                wire::session_update(
                    session_id,
                    json!({
                        "sessionUpdate": "agent_thought_chunk",
                        "content": { "type": "text", "text": t.thinking },
                    }),
                ),
            )
            .await;
        }

        // Tool lifecycle. buzz-agent guaranteed every announced tool reached a
        // terminal state, or the desktop UI shows a stuck spinner
        // (`agent.rs:470-477`). Goose emits request and response as separate
        // messages, so the pairing is by tool-call id.
        MessageContent::ToolRequest(req) => {
            let (name, raw) = match &req.tool_call {
                Ok(call) => (
                    call.name.to_string(),
                    serde_json::to_value(&call.arguments).unwrap_or(Value::Null),
                ),
                Err(e) => (String::from("unknown"), json!({ "error": e.to_string() })),
            };
            wire::send(
                wire_tx,
                wire::session_update(
                    session_id,
                    json!({
                        "sessionUpdate": "tool_call",
                        "toolCallId": req.id,
                        "title": name,
                        "kind": "other",
                        "status": "in_progress",
                        "rawInput": raw,
                    }),
                ),
            )
            .await;
        }

        MessageContent::ToolResponse(resp) => {
            let failed = match &resp.tool_result {
                Ok(r) => r.is_error.unwrap_or(false),
                Err(_) => true,
            };
            wire::send(
                wire_tx,
                wire::session_update(
                    session_id,
                    json!({
                        "sessionUpdate": "tool_call_update",
                        "toolCallId": resp.id,
                        "status": if failed { "failed" } else { "completed" },
                    }),
                ),
            )
            .await;
        }

        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_flattens_text_blocks() {
        let blocks = vec![
            ContentBlock::Text {
                text: "hello".into(),
            },
            ContentBlock::Text {
                text: "world".into(),
            },
        ];
        assert_eq!(prompt_to_text(&blocks), "hello\nworld");
    }

    #[test]
    fn prompt_includes_resource_links() {
        let blocks = vec![
            ContentBlock::Text { text: "see".into() },
            ContentBlock::ResourceLink {
                uri: "file:///a".into(),
            },
        ];
        assert_eq!(prompt_to_text(&blocks), "see\nfile:///a");
    }

    #[test]
    fn prompt_skips_unsupported() {
        let blocks = vec![
            ContentBlock::Unsupported,
            ContentBlock::Text {
                text: "only".into(),
            },
        ];
        assert_eq!(prompt_to_text(&blocks), "only");
    }

    #[test]
    fn turn_tokens_observed_requires_a_count() {
        assert!(!TurnTokens::default().observed());
        assert!(TurnTokens {
            input: Some(1),
            output: None
        }
        .observed());
        assert!(TurnTokens {
            input: None,
            output: Some(1)
        }
        .observed());
    }
}
