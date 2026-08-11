//! buzz-agent's own agent loop, built from goose components.
//!
//! # Who owns what
//!
//! This is the deliberate inversion of the earlier design, where the turn was
//! `goose::agents::Agent::reply` and buzz-agent only translated the resulting
//! event stream onto the ACP wire. **buzz-agent owns the loop.** goose is a
//! parts bin:
//!
//! | concern | goose API used |
//! |---|---|
//! | model call | `Provider::stream` (via `Agent::provider`) |
//! | tool surface | `Agent::list_tools` |
//! | tool execution | `Agent::dispatch_tool_call` |
//! | system prompt | `Agent::build_turn_system_prompt` → `PromptManager` |
//! | compaction | `goose::context_mgmt::{check_if_compaction_needed, compact_messages}` |
//! | conversation store | `SessionManager` (sqlite), read/written by us |
//!
//! Everything that decides *turn shape* stays here: round structure, the
//! `_Stop` veto, `[Reflect]` on tool failure, `[PostCompact]` re-injection,
//! steer draining, cancellation semantics, and the ACP `session/update`
//! emission.
//!
//! # Why own the loop
//!
//! `Agent::reply` bakes in goose's own turn policy — its compaction trigger,
//! its stop-hook handling, its steer drain points, its max-turns rule. Every
//! buzz-specific behaviour then has to be smuggled in around the edges
//! (see the old `run_turn`: an outer loop purely to re-enter `reply()` for the
//! `_Stop` veto, and `[Reflect]` delivered as a *steer* because the tool
//! result itself was out of reach). Driving the components directly removes
//! the smuggling: the veto is a branch, `[Reflect]` is appended to the tool
//! result where buzz-agent originally put it.
//!
//! # Round structure
//!
//! One round is: build prompt+tools → stream from the provider → persist the
//! assistant message → if it asked for tools, run them, append results, and
//! loop; otherwise the turn wants to end, at which point `_Stop` may veto it.
//!
//! Compaction is checked at the top of each round rather than mid-stream, so a
//! rewrite of history can never race a partially-consumed response.

use std::sync::Arc;

use futures::StreamExt;
use tokio_util::sync::CancellationToken;

use goose::agents::Agent;
use goose::session::session_manager::{Session, SessionManager};
use goose_provider_types::conversation::message::{Message, MessageContent, ToolRequest};
use goose_provider_types::conversation::Conversation;

use crate::types::{AgentError, StopReason};
use crate::wire::WireSender;

/// Appended to every failed tool result so the model diagnoses the failure
/// instead of blindly retrying it.
///
/// This is buzz-agent's original behaviour, restored. Under `Agent::reply` the
/// tool result was owned by goose and unreachable, so the text had to be
/// delivered as a steer instead; owning the loop means we can put it back on
/// the result where the model reads it in context.
const ERROR_REFLECTION: &str =
    "[Reflect] Before retrying, identify the cause and change your approach.";

/// Cap on reflections per turn, so a tool failing in a loop cannot flood the
/// conversation.
const MAX_REFLECTIONS: usize = 8;

/// Hard cap on consecutive `_Stop` vetoes, mirroring goose's own
/// `stop_hook_block_cap`. A tool that always objects must not trap the turn.
pub const MAX_STOP_BLOCKS: u32 = 3;

/// Rounds allowed when the caller sets no limit.
///
/// buzz-agent's loop was previously bounded by goose's `max_turns`. Owning the
/// loop means owning the bound, and an unbounded loop against a model that
/// tool-calls forever is a runaway spend.
const DEFAULT_MAX_ROUNDS: u32 = 1000;

/// Outcome of a single round, as decided by this loop.
enum Round {
    /// The model asked for tools; they ran and their results are in history.
    Continued,
    /// The model produced a final answer.
    WantsToEnd,
    /// A terminal condition the loop must surrender to.
    Stopped(StopReason),
}

/// Everything a round needs that does not change between rounds.
pub struct TurnContext<'a> {
    pub agent: &'a Arc<Agent>,
    pub session_id: &'a str,
    pub wire_tx: &'a WireSender,
    pub cancel: &'a CancellationToken,
    pub hook_extension: Option<&'a str>,
    pub max_rounds: Option<u32>,
    /// This session's system prompt. buzz-agent owns it because goose's own
    /// `PromptManager` is only reachable from `Agent::reply`.
    pub prompt: &'a crate::prompt::SessionPrompt,
    /// Messages injected mid-turn by `session/steer`. Drained at the round
    /// boundary; a pending steer also blocks the end of the turn.
    pub steers: &'a crate::steer::SteerQueue,
}

/// Drive one `session/prompt` turn to completion.
///
/// Returns the ACP stop reason plus the turn's token counts. The caller emits
/// `usage_update` *before* the `session/prompt` response — that ordering is
/// load-bearing for kind-44200 metrics.
pub async fn run_turn(
    ctx: TurnContext<'_>,
    prompt: Message,
) -> (Result<StopReason, AgentError>, super::agent::TurnTokens) {
    let mut tokens = super::agent::TurnTokens::default();
    let sessions = crate::session_store::session_manager();

    // The user's prompt is persisted before the first inference so a resumed
    // or inspected session sees the same history the model saw.
    if let Err(e) = sessions.add_message(ctx.session_id, &prompt).await {
        return (Err(AgentError::Llm(format!("persist prompt: {e}"))), tokens);
    }

    let max_rounds = ctx.max_rounds.unwrap_or(DEFAULT_MAX_ROUNDS);
    let mut rounds = 0u32;
    let mut stop_blocks = 0u32;
    let mut reflections = 0usize;

    loop {
        if ctx.cancel.is_cancelled() {
            return (Ok(StopReason::Cancelled), tokens);
        }
        if rounds >= max_rounds {
            tracing::warn!(rounds, "max rounds reached; ending turn");
            return (Ok(StopReason::MaxTurnRequests), tokens);
        }
        rounds += 1;

        // Steers land here, at the round boundary — never mid-inference,
        // where they would race a partially streamed response.
        for message in ctx.steers.drain().await {
            if let Err(e) = sessions.add_message(ctx.session_id, &message).await {
                return (Err(AgentError::Llm(format!("persist steer: {e}"))), tokens);
            }
        }

        // Compaction at the round boundary, never mid-stream.
        if let Err(e) = maybe_compact(&ctx, &sessions).await {
            tracing::warn!(error = %e, "compaction failed; continuing uncompacted");
        }

        match round(&ctx, &sessions, &mut tokens, &mut reflections).await {
            Err(e) => return (Err(e), tokens),
            Ok(Round::Continued) => continue,
            Ok(Round::Stopped(reason)) => return (Ok(reason), tokens),
            Ok(Round::WantsToEnd) => {
                // A steer that arrived while the model was finishing must be
                // answered, not dropped — so it also blocks the end of turn.
                if ctx.steers.is_pending().await && !ctx.cancel.is_cancelled() {
                    continue;
                }

                // The turn wants to end. `_Stop` gets a veto.
                match stop_veto(&ctx, &sessions, &mut stop_blocks).await {
                    Some(objection) => {
                        let message = Message::user()
                            .with_text(format!("[Stop] {objection}"))
                            .with_visibility(false, true);
                        if let Err(e) = sessions.add_message(ctx.session_id, &message).await {
                            return (Err(AgentError::Llm(format!("persist stop: {e}"))), tokens);
                        }
                        continue;
                    }
                    None => {
                        // A steer arriving after this point belongs to no run.
                        ctx.steers.clear().await;
                        return (Ok(StopReason::EndTurn), tokens);
                    }
                }
            }
        }
    }
}

/// One inference plus, if the model asked for them, one batch of tool calls.
async fn round(
    ctx: &TurnContext<'_>,
    sessions: &SessionManager,
    tokens: &mut super::agent::TurnTokens,
    reflections: &mut usize,
) -> Result<Round, AgentError> {
    let session = load_session(sessions, ctx.session_id).await?;
    let conversation = session.conversation.clone().unwrap_or_default();

    let assistant = match infer(ctx, &session, &conversation, tokens).await? {
        Some(message) => message,
        // A provider that returns nothing is not a turn we can continue.
        None => return Ok(Round::Stopped(StopReason::EndTurn)),
    };

    sessions
        .add_message(ctx.session_id, &assistant)
        .await
        .map_err(|e| AgentError::Llm(format!("persist assistant: {e}")))?;

    let requests: Vec<ToolRequest> = assistant
        .content
        .iter()
        .filter_map(|content| match content {
            MessageContent::ToolRequest(req) => Some(req.clone()),
            _ => None,
        })
        .collect();

    if requests.is_empty() {
        return Ok(Round::WantsToEnd);
    }

    if ctx.cancel.is_cancelled() {
        // Announced tool calls must still reach a terminal state or the
        // desktop renders a spinner forever.
        let results = crate::tools::cancelled_results(&requests);
        for request in &requests {
            crate::agent::emit_tool_call_update(ctx.wire_tx, ctx.session_id, &request.id, true)
                .await;
        }
        persist_tool_results(ctx, sessions, results).await?;
        return Ok(Round::Stopped(StopReason::Cancelled));
    }

    // Tool arguments feed goose's subdirectory-hint tracker, so the next
    // round's prompt picks up an AGENTS.md in a directory we just touched.
    for request in &requests {
        if let Ok(call) = &request.tool_call {
            ctx.prompt
                .record_tool_arguments(&call.arguments, &session.working_dir)
                .await;
        }
    }

    let results = crate::tools::execute(
        ctx.agent,
        &session,
        ctx.wire_tx,
        ctx.cancel,
        &requests,
        reflections,
    )
    .await;
    persist_tool_results(ctx, sessions, results).await?;

    Ok(Round::Continued)
}

/// Stream one assistant response, emitting chunks onto the ACP wire as they
/// arrive and accumulating usage.
async fn infer(
    ctx: &TurnContext<'_>,
    session: &Session,
    conversation: &Conversation,
    tokens: &mut super::agent::TurnTokens,
) -> Result<Option<Message>, AgentError> {
    let provider = ctx
        .agent
        .provider()
        .await
        .map_err(|e| AgentError::Llm(e.to_string()))?;
    let model_config = ctx
        .agent
        .model_config_for_session(ctx.session_id)
        .await
        .map_err(|e| AgentError::LlmModelNotFound(e.to_string()))?;

    let system_prompt = ctx.prompt.build(&session.working_dir).await;
    let tools = ctx.agent.list_tools(ctx.session_id, None).await;

    let mut stream = provider
        .stream(
            &model_config,
            &system_prompt,
            conversation.messages(),
            &tools,
        )
        .await
        .map_err(|e| classify_provider_error(&e.to_string()))?;

    let mut accumulated: Option<Message> = None;
    let mut keepalive = tokio::time::interval(crate::agent::KEEPALIVE_INTERVAL);
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    keepalive.tick().await; // first tick is immediate; discard it

    loop {
        tokio::select! {
            // Keep the harness idle clock alive during provider silence.
            _ = keepalive.tick() => {
                crate::agent::emit_keepalive(ctx.session_id, ctx.wire_tx).await;
            }

            // Cancelling the model call is safe to do abruptly: unlike tool
            // dispatch there is no child process to notify, and the partial
            // response is discarded rather than persisted.
            _ = ctx.cancel.cancelled() => {
                return Ok(accumulated);
            }

            next = stream.next() => {
                let Some(item) = next else { break };
                let (message, usage) = item.map_err(|e| classify_provider_error(&e.to_string()))?;

                if let Some(usage) = usage {
                    accumulate_usage(tokens, &usage);
                }

                let Some(chunk) = message else { continue };
                for content in &chunk.content {
                    crate::agent::emit_content(content, ctx.session_id, ctx.wire_tx).await;
                }
                accumulated = Some(match accumulated {
                    None => chunk,
                    Some(mut prev) => {
                        merge_chunk(&mut prev, chunk);
                        prev
                    }
                });
            }
        }
    }

    Ok(accumulated)
}

/// Fold a streamed chunk into the message being accumulated.
///
/// Text arrives fragmented and must be coalesced or the persisted history
/// contains one message per token; tool calls arrive whole and are appended.
fn merge_chunk(target: &mut Message, chunk: Message) {
    for content in chunk.content {
        match (target.content.last_mut(), &content) {
            (Some(MessageContent::Text(last)), MessageContent::Text(new)) => {
                last.text.push_str(&new.text);
            }
            (Some(MessageContent::Thinking(last)), MessageContent::Thinking(new)) => {
                last.thinking.push_str(&new.thinking);
            }
            _ => target.content.push(content),
        }
    }
}

fn accumulate_usage(
    tokens: &mut super::agent::TurnTokens,
    usage: &goose::providers::base::ProviderUsage,
) {
    let u = &usage.usage;
    if let Some(i) = u.input_tokens {
        tokens.input = Some(tokens.input.unwrap_or(0) + i.max(0) as u64);
    }
    if let Some(o) = u.output_tokens {
        tokens.output = Some(tokens.output.unwrap_or(0) + o.max(0) as u64);
    }
    if u.cache_read_input_tokens.is_some() || u.cache_write_input_tokens.is_some() {
        let cached = u.cache_read_input_tokens.unwrap_or(0).max(0) as u64
            + u.cache_write_input_tokens.unwrap_or(0).max(0) as u64;
        tokens.cached_input = Some(tokens.cached_input.unwrap_or(0) + cached);
    }
    if let Some(t) = u.total_tokens {
        tokens.total = Some(tokens.total.unwrap_or(0) + t.max(0) as u64);
    }
}

/// Persist tool results as a single user message, matching the shape every
/// provider wire format expects (one result per outstanding request).
async fn persist_tool_results(
    ctx: &TurnContext<'_>,
    sessions: &SessionManager,
    results: Vec<(
        String,
        goose_provider_types::conversation::message::ToolResult<rmcp::model::CallToolResult>,
    )>,
) -> Result<(), AgentError> {
    if results.is_empty() {
        return Ok(());
    }
    let mut message = Message::user();
    for (id, result) in results {
        message = message.with_tool_response(id, result);
    }
    sessions
        .add_message(ctx.session_id, &message)
        .await
        .map_err(|e| AgentError::Llm(format!("persist tool results: {e}")))
}

/// Compact history when it is close to the context limit, then re-inject the
/// state `_PostCompact` reports so a todo list survives the truncation.
async fn maybe_compact(ctx: &TurnContext<'_>, sessions: &SessionManager) -> anyhow::Result<()> {
    let session = sessions.get_session(ctx.session_id, true).await?;
    let Some(conversation) = session.conversation.clone() else {
        return Ok(());
    };
    let provider = ctx.agent.provider().await?;

    if !goose::context_mgmt::check_if_compaction_needed(
        provider.as_ref(),
        &conversation,
        None,
        &session,
    )
    .await?
    {
        return Ok(());
    }

    let model_config = ctx.agent.model_config_for_session(ctx.session_id).await?;
    let result = goose::context_mgmt::compact_messages(
        provider.as_ref(),
        &model_config,
        ctx.session_id,
        &conversation,
        false,
    )
    .await?;

    sessions
        .replace_conversation(ctx.session_id, &result.conversation)
        .await?;
    tracing::info!(target: "buzz_agent::compaction", "history compacted");

    // `_PostCompact` state is what buzz-agent's handoff existed to preserve.
    if let Some(extension) = ctx.hook_extension {
        let session = sessions.get_session(ctx.session_id, true).await?;
        if let Some(state) = crate::hooks::post_compact_state(ctx.agent, &session, extension).await
        {
            let message = Message::user()
                .with_text(format!("[PostCompact] {state}"))
                .with_visibility(false, true);
            sessions.add_message(ctx.session_id, &message).await?;
        }
    }

    Ok(())
}

/// Ask `_Stop` whether the turn may end. `Some(objection)` means keep working.
async fn stop_veto(
    ctx: &TurnContext<'_>,
    sessions: &SessionManager,
    stop_blocks: &mut u32,
) -> Option<String> {
    if ctx.cancel.is_cancelled() {
        return None;
    }
    let extension = ctx.hook_extension?;

    if *stop_blocks >= MAX_STOP_BLOCKS {
        tracing::warn!(blocks = *stop_blocks, "_Stop veto cap reached; ending turn");
        return None;
    }

    let session = sessions.get_session(ctx.session_id, false).await.ok()?;
    let objection = crate::hooks::stop_objection(ctx.agent, &session, extension).await?;

    *stop_blocks += 1;
    tracing::info!(blocks = *stop_blocks, "_Stop hook vetoed end of turn");
    Some(objection)
}

async fn load_session(sessions: &SessionManager, id: &str) -> Result<Session, AgentError> {
    sessions
        .get_session(id, true)
        .await
        .map_err(|e| AgentError::Llm(format!("load session: {e}")))
}

/// Preserve buzz-agent's error taxonomy so the harness's JSON-RPC code mapping
/// stays meaningful.
fn classify_provider_error(msg: &str) -> AgentError {
    let lower = msg.to_lowercase();
    if lower.contains("auth") || lower.contains("401") {
        AgentError::LlmAuth(msg.to_string())
    } else if lower.contains("model") && lower.contains("not found") {
        AgentError::LlmModelNotFound(msg.to_string())
    } else {
        AgentError::Llm(msg.to_string())
    }
}

/// Text appended to a failed tool result, exposed for the tool module.
pub(crate) fn reflection_text() -> &'static str {
    ERROR_REFLECTION
}

pub(crate) fn max_reflections() -> usize {
    MAX_REFLECTIONS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_coalesces_consecutive_text() {
        let mut target = Message::assistant().with_text("hel");
        merge_chunk(&mut target, Message::assistant().with_text("lo"));
        assert_eq!(target.as_concat_text(), "hello");
        assert_eq!(target.content.len(), 1, "text must coalesce, not append");
    }

    #[test]
    fn merge_appends_distinct_content_kinds() {
        let mut target = Message::assistant().with_text("thinking about it");
        merge_chunk(
            &mut target,
            Message::assistant()
                .with_tool_response("id", Ok(rmcp::model::CallToolResult::success(vec![]))),
        );
        assert_eq!(target.content.len(), 2);
    }

    #[test]
    fn provider_errors_keep_buzz_agents_taxonomy() {
        assert!(matches!(
            classify_provider_error("401 Unauthorized"),
            AgentError::LlmAuth(_)
        ));
        assert!(matches!(
            classify_provider_error("model gpt-9 not found"),
            AgentError::LlmModelNotFound(_)
        ));
        assert!(matches!(
            classify_provider_error("connection reset"),
            AgentError::Llm(_)
        ));
    }
}
