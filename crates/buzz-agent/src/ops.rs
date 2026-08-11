//! buzz-agent's loop decisions, as goose `Operation`s.
//!
//! goose's `StateMachine` runs an ordered list of operations and re-runs the
//! whole list from the top after each one applies. Expressing buzz's decisions
//! as operations makes their precedence *list order* rather than control flow,
//! and makes each one testable without a provider.
//!
//! goose's own concrete operations are `pub(super)`, so these are buzz's. That
//! is the intent rather than a workaround: buzz's rules differ (no recipes, no
//! slash commands, no tool approval, no retry), and the traits are public
//! precisely so an embedder can bring its own.
//!
//! # Signalling a stop reason
//!
//! `StateEffect` can append messages and `yielded()` can end the turn, but
//! neither carries *why*. buzz's caller has to answer `session/prompt` with a
//! specific ACP `stopReason`, so operations record it in a shared [`Outcome`]
//! cell that the driving loop reads after the step. This is the one piece of
//! state the state machine does not model for us.

use std::sync::{Arc, Mutex};

use anyhow::Result;
use async_trait::async_trait;
use goose::agents::state_machine::{not_applicable, yielded, Emitter, Operation, OperationResult};
use goose::conversation::Conversation;
use goose::session::Session;
use goose_provider_types::conversation::message::Message;

use crate::types::StopReason;

/// Messages belonging to the current turn: everything from the last
/// user-visible, non-tool-response message onward.
///
/// goose has this as `messages_since_kickoff`, but its `operation` module is
/// private (`mod operation;`) so only the names re-exported from
/// `state_machine` escape the crate — the helpers do not. Reimplemented here
/// to match goose's semantics exactly; see `operation.rs:23`.
fn messages_since_kickoff(conversation: &Conversation) -> Option<&[Message]> {
    let messages = conversation.messages();
    let start = messages.iter().rposition(|message| {
        message.role == rmcp::model::Role::User
            && message.is_user_visible()
            && !message.is_tool_response()
    })?;
    Some(&messages[start..])
}

/// Count assistant turns, treating a run of consecutive assistant messages as
/// one turn. Mirrors goose's `assistant_turn_count` (`operation.rs:47`).
fn assistant_turn_count(messages: &[Message]) -> u32 {
    let mut turns = 0;
    let mut in_assistant_block = false;
    for message in messages.iter().rev() {
        if message.role == rmcp::model::Role::Assistant {
            if !in_assistant_block {
                turns += 1;
                in_assistant_block = true;
            }
        } else {
            in_assistant_block = false;
        }
    }
    turns
}

/// Why the turn stopped, as decided by whichever operation applied.
///
/// Shared with the loop because `StepResult` says *that* a step yielded, not
/// which one or with what reason.
#[derive(Clone, Default)]
pub struct Outcome(Arc<Mutex<Option<StopReason>>>);

impl Outcome {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the reason the turn ended. First writer wins: the machine stops
    /// at the first operation that applies, so a later write would describe a
    /// decision that never took effect.
    fn set(&self, reason: StopReason) {
        let mut slot = match self.0.lock() {
            Ok(slot) => slot,
            // A poisoned lock means another thread panicked mid-write. The
            // turn still has to answer with *some* stop reason, so recover the
            // guard rather than propagating a panic into the loop.
            Err(poisoned) => poisoned.into_inner(),
        };
        if slot.is_none() {
            *slot = Some(reason);
        }
    }

    /// Take the recorded reason, if any.
    pub fn take(&self) -> Option<StopReason> {
        match self.0.lock() {
            Ok(mut slot) => slot.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        }
    }
}

/// Ends the turn once the model has had its budget of provider round-trips.
///
/// buzz-agent's loop was previously bounded by goose's `max_turns`; owning the
/// loop means owning the bound, and an unbounded loop against a model that
/// tool-calls forever is a runaway spend.
///
/// Deliberately *not* goose's `MaxTurnsOperation`, which appends an assistant
/// message ("Would you like me to continue?") before yielding. buzz-acp
/// surfaces the exhausted budget through the `max_turn_requests` stop reason
/// instead, and injecting a chat message the model never produced would put
/// words in the agent's mouth in a Buzz channel.
pub struct BuzzMaxRoundsOperation {
    max_rounds: u32,
    outcome: Outcome,
}

impl BuzzMaxRoundsOperation {
    pub fn new(max_rounds: u32, outcome: Outcome) -> Self {
        Self {
            max_rounds,
            outcome,
        }
    }
}

#[async_trait]
impl Operation for BuzzMaxRoundsOperation {
    fn name(&self) -> &'static str {
        "buzz_max_rounds"
    }

    async fn run(
        &self,
        _session: &Session,
        conversation: &Conversation,
        _emit: &Emitter,
    ) -> Result<OperationResult> {
        // Counted from the kickoff message, so the budget is per *turn* and
        // does not leak across prompts in a long-lived session. Counting
        // assistant turns rather than loop iterations also means the bound
        // survives a restart, which a loop-local counter did not.
        let Some(messages) = messages_since_kickoff(conversation) else {
            // No kickoff message means no turn is in progress, so there is no
            // budget to exceed. goose errors here; buzz declines instead --
            // an operation that cannot decide must not end the turn.
            return not_applicable();
        };
        let rounds = assistant_turn_count(messages);
        if rounds < self.max_rounds {
            return not_applicable();
        }

        tracing::warn!(rounds, "max rounds reached; ending turn");

        self.outcome.set(StopReason::MaxTurnRequests);
        yielded()
    }
}

/// The operations that gate the start of a round.
///
/// One entry today. As `PLANS/BUZZ_OPERATIONS_MIGRATION.md` proceeds, the
/// steer drain, compaction, the `_Stop` veto and `[Reflect]` join it, and
/// their precedence becomes the order of this list.
pub fn round_gate(
    max_rounds: u32,
    outcome: Outcome,
    cancel: tokio_util::sync::CancellationToken,
) -> goose::agents::state_machine::StateMachine<'static> {
    let steps = vec![goose::agents::state_machine::Step::Operation(Arc::new(
        BuzzMaxRoundsOperation::new(max_rounds, outcome),
    ))];
    goose::agents::state_machine::StateMachine::new(steps, cancel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    fn emitter() -> Emitter {
        let (tx, rx) = mpsc::channel(16);
        // Keep the receiver alive for the duration of the test: a dropped
        // receiver makes every emit fail silently, which would mask a real
        // regression in an operation that emits.
        std::mem::forget(rx);
        Emitter::new(tx, CancellationToken::new())
    }

    /// A turn in progress: one user kickoff, then `assistant_turns` rounds of
    /// assistant work.
    ///
    /// Tool responses separate the assistant messages because consecutive
    /// assistant messages count as a *single* turn -- which is the real shape
    /// anyway, since a round that continues does so by calling a tool.
    fn conversation(assistant_turns: usize) -> Conversation {
        let mut messages = vec![Message::user().with_text("kickoff")];
        for i in 0..assistant_turns {
            messages.push(Message::assistant().with_text(format!("turn {i}")));
            if i + 1 < assistant_turns {
                messages.push(tool_response());
            }
        }
        Conversation::new_unvalidated(messages)
    }

    /// A user-role message that does *not* reset the kickoff, standing in for
    /// a tool result.
    fn tool_response() -> Message {
        Message::user()
            .with_text("tool output")
            .with_visibility(false, true)
    }

    #[tokio::test]
    async fn under_budget_does_not_apply() {
        let outcome = Outcome::new();
        let op = BuzzMaxRoundsOperation::new(3, outcome.clone());
        let result = op
            .run(&Session::default(), &conversation(2), &emitter())
            .await
            .unwrap();
        assert!(matches!(result, OperationResult::NotApplicable));
        assert!(outcome.take().is_none());
    }

    #[tokio::test]
    async fn at_budget_ends_the_turn_with_max_turn_requests() {
        let outcome = Outcome::new();
        let op = BuzzMaxRoundsOperation::new(3, outcome.clone());
        let result = op
            .run(&Session::default(), &conversation(3), &emitter())
            .await
            .unwrap();
        match result {
            OperationResult::Applied(step) => assert!(step.yield_to_client),
            OperationResult::NotApplicable => panic!("budget was reached but nothing applied"),
        }
        assert!(matches!(outcome.take(), Some(StopReason::MaxTurnRequests)));
    }

    #[tokio::test]
    async fn the_budget_appends_no_message() {
        // goose's MaxTurnsOperation asks "Would you like me to continue?".
        // buzz must not: buzz-acp publishes assistant messages to a channel,
        // so a synthesised one would be indistinguishable from the agent
        // actually saying it.
        let op = BuzzMaxRoundsOperation::new(1, Outcome::new());
        let result = op
            .run(&Session::default(), &conversation(1), &emitter())
            .await
            .unwrap();
        match result {
            OperationResult::Applied(step) => assert!(step.effects.is_empty()),
            OperationResult::NotApplicable => panic!("budget was reached but nothing applied"),
        }
    }

    #[test]
    fn the_first_recorded_reason_wins() {
        // The machine stops at the first operation that applies, so a second
        // write would name a decision that never took effect.
        let outcome = Outcome::new();
        outcome.set(StopReason::MaxTurnRequests);
        outcome.set(StopReason::Cancelled);
        assert!(matches!(outcome.take(), Some(StopReason::MaxTurnRequests)));
    }

    #[tokio::test]
    async fn a_mid_turn_steer_restarts_the_budget() {
        // A steer is a user-visible message, so it becomes the new kickoff and
        // the budget counts from there. That is the behaviour we want -- the
        // user gave fresh direction, so the agent gets a fresh allowance --
        // but it is emergent rather than chosen, so pin it: the alternative
        // (a steer silently inheriting an almost-exhausted budget) would cut
        // the agent off mid-instruction.
        let outcome = Outcome::new();
        let op = BuzzMaxRoundsOperation::new(2, outcome.clone());

        let mut messages = conversation(2).messages().to_vec();
        messages.push(
            Message::user()
                .with_text("actually, do this instead")
                .with_steer(),
        );
        messages.push(Message::assistant().with_text("ok"));
        let steered = Conversation::new_unvalidated(messages);

        let result = op
            .run(&Session::default(), &steered, &emitter())
            .await
            .unwrap();
        assert!(
            matches!(result, OperationResult::NotApplicable),
            "the steer should have restarted the turn budget"
        );
        assert!(outcome.take().is_none());
    }
}
