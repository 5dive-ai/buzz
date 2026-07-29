//! First-class `send_message` tool: publish an agent reply to a Buzz channel.
//!
//! # Why this exists
//!
//! Before this tool, the only way for an agent to speak was to compose a
//! `buzz messages send …` command string inside a [`crate::shell`] call. That
//! indirection is reliable for large frontier models and unreliable for the
//! small local models Buzz shared compute is built to serve: given the real
//! ~3.2k-token Buzz system prompt, Gemma 4 E4B answered in prose instead of
//! calling `shell` in 6 of 8 samples — and in several it emitted the literal
//! command text as assistant content. Assistant text is never published, so
//! those replies were silently dropped.
//!
//! Exposing the publish action as its own typed tool removes the indirection:
//! the model picks a tool by name and fills one string field. Measured against
//! the real system prompt and the real dev-mcp toolset, delivery went from 2/8
//! to 8/8 on E4B and 6/6 on 26B-A4B.
//!
//! The tool deliberately duplicates no process machinery: it builds an argv,
//! quotes it, and hands the command to [`crate::shell::run`], inheriting that
//! module's timeout, output capping, cancellation, and process-group kill.

use crate::shell::{self, SharedState, ShellParams};

use rmcp::model::CallToolResult;
use rmcp::ErrorData;
use schemars::JsonSchema;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

/// Timeout for a publish. A send is a single small relay round-trip; if it has
/// not completed in 30s the relay is unreachable and a longer wait only stalls
/// the turn.
const SEND_TIMEOUT_MS: u64 = 30_000;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SendMessageParams {
    /// Channel UUID to post to — the one from the `[Context]` block.
    pub channel: String,
    /// The message text to publish.
    pub content: String,
    /// Optional event id to thread this reply under. Use the reply destination
    /// supplied in `[Context]`.
    #[serde(default)]
    pub reply_to: Option<String>,
}

/// Single-quote `s` for POSIX shells: wrap in `'…'` and escape embedded quotes
/// as `'\''`. Every other byte — including newlines, `$`, backticks, and `;` —
/// is literal inside single quotes, so this is total rather than a blocklist.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Normalize an id the model copied out of the prompt, then validate it.
///
/// The `[Context]` block renders a channel as `general (#adafd400-…)`, so
/// models routinely pass `#adafd400-…` or the whole `general (#adafd400-…)`
/// span. Both name the right channel, and failing them would push the model
/// back to prose — the exact failure this tool exists to remove. So a leading
/// `#` and a surrounding `name (…)` wrapper are stripped rather than rejected.
///
/// Anything still not a bare id after normalization is rejected, so shell
/// metacharacters can never reach the command line.
fn normalize_id(kind: &str, value: &str) -> Result<String, ErrorData> {
    let mut v = value.trim();
    // `general (#uuid)` → `#uuid`. Only a `#`-prefixed span is unwrapped:
    // unwrapping any parenthesized text would let `$(id)` become `id` and pass
    // validation, turning this normalizer into a command-substitution escape.
    if let (Some(open), Some(close)) = (v.rfind('('), v.rfind(')')) {
        if open < close {
            let inner = v[open + 1..close].trim();
            if inner.starts_with('#') {
                v = inner;
            }
        }
    }
    let v = v.strip_prefix('#').unwrap_or(v).trim();

    let ok = !v.is_empty()
        && v.len() <= 64
        && v.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(v.to_string())
    } else {
        Err(ErrorData::invalid_params(
            format!("{kind} must be a bare id (alphanumeric, '-', '_'); got {value:?}"),
            None,
        ))
    }
}

/// Build the `buzz messages send` command line for `p`.
///
/// Split out from [`run`] so the quoting and flag order are unit-testable
/// without spawning a process.
fn build_command(p: &SendMessageParams) -> Result<String, ErrorData> {
    let channel = normalize_id("channel", &p.channel)?;
    let reply_to = match &p.reply_to {
        // An explicitly empty `reply_to` means "no thread", not a bad argument:
        // models fill optional string fields with "" rather than omitting them.
        Some(v) if v.trim().is_empty() => None,
        Some(v) => Some(normalize_id("reply_to", v)?),
        None => None,
    };
    if p.content.trim().is_empty() {
        return Err(ErrorData::invalid_params(
            "content must not be empty".to_string(),
            None,
        ));
    }

    let mut cmd = format!(
        "buzz messages send --channel {} --content {}",
        shell_quote(&channel),
        shell_quote(&p.content)
    );
    if let Some(reply_to) = &reply_to {
        cmd.push_str(&format!(" --reply-to {}", shell_quote(reply_to)));
    }
    Ok(cmd)
}

pub async fn run(
    state: &SharedState,
    p: SendMessageParams,
    ct: CancellationToken,
) -> Result<CallToolResult, ErrorData> {
    let command = build_command(&p)?;
    shell::run(
        state,
        ShellParams {
            command,
            workdir: None,
            timeout_ms: Some(SEND_TIMEOUT_MS),
        },
        ct,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(channel: &str, content: &str, reply_to: Option<&str>) -> SendMessageParams {
        SendMessageParams {
            channel: channel.to_string(),
            content: content.to_string(),
            reply_to: reply_to.map(str::to_string),
        }
    }

    #[test]
    fn builds_plain_send() {
        let cmd = build_command(&params("abc-123", "hello there", None)).unwrap();
        assert_eq!(
            cmd,
            "buzz messages send --channel 'abc-123' --content 'hello there'"
        );
    }

    #[test]
    fn threads_reply_when_reply_to_present() {
        let cmd = build_command(&params("abc-123", "hi", Some("deadbeef"))).unwrap();
        assert_eq!(
            cmd,
            "buzz messages send --channel 'abc-123' --content 'hi' --reply-to 'deadbeef'"
        );
    }

    #[test]
    fn quotes_content_containing_single_quotes() {
        let cmd = build_command(&params("c", "it's fine", None)).unwrap();
        assert_eq!(
            cmd,
            r"buzz messages send --channel 'c' --content 'it'\''s fine'"
        );
    }

    /// Content is attacker-influenced (it is model output, which can echo
    /// untrusted channel text), so shell metacharacters must stay inert.
    #[test]
    fn neutralizes_shell_metacharacters_in_content() {
        for payload in [
            "; rm -rf /",
            "$(whoami)",
            "`id`",
            "a && b",
            "x | tee /tmp/y",
            "line1\nline2",
            "$HOME",
        ] {
            let cmd = build_command(&params("c", payload, None)).unwrap();
            let quoted = shell_quote(payload);
            assert!(
                cmd.ends_with(&format!("--content {quoted}")),
                "payload {payload:?} must be fully single-quoted, got {cmd}"
            );
            // Nothing escapes the quoted region: the only unquoted single
            // quotes are the ones our escaping introduces.
            assert_eq!(
                cmd.matches('\'').count() % 2,
                0,
                "unbalanced quoting for {payload:?}"
            );
        }
    }

    #[test]
    fn rejects_channel_with_shell_metacharacters() {
        let err = build_command(&params("abc; rm -rf /", "hi", None)).unwrap_err();
        assert!(err.message.contains("channel must be a bare id"));
    }

    #[test]
    fn rejects_reply_to_with_shell_metacharacters() {
        let err = build_command(&params("abc", "hi", Some("$(id)"))).unwrap_err();
        assert!(err.message.contains("reply_to must be a bare id"));
    }

    #[test]
    fn rejects_empty_channel() {
        assert!(build_command(&params("", "hi", None)).is_err());
    }

    #[test]
    fn rejects_blank_content() {
        // A whitespace-only reply is never a deliberate message; failing here
        // surfaces the mistake to the model instead of posting an empty event.
        assert!(build_command(&params("c", "   ", None)).is_err());
    }

    #[test]
    fn strips_hash_prefix_from_channel() {
        // `[Context]` renders `general (#uuid)`, so models pass `#uuid`.
        let cmd = build_command(&params("#abc-123", "hi", None)).unwrap();
        assert_eq!(cmd, "buzz messages send --channel 'abc-123' --content 'hi'");
    }

    #[test]
    fn unwraps_full_context_channel_span() {
        let cmd = build_command(&params("general (#abc-123)", "hi", None)).unwrap();
        assert_eq!(cmd, "buzz messages send --channel 'abc-123' --content 'hi'");
    }

    #[test]
    fn treats_empty_reply_to_as_absent() {
        // Small models fill optional string fields with "" instead of omitting.
        let cmd = build_command(&params("abc", "hi", Some(""))).unwrap();
        assert_eq!(cmd, "buzz messages send --channel 'abc' --content 'hi'");
    }

    #[test]
    fn normalization_cannot_smuggle_metacharacters() {
        // Stripping must not become an escape hatch: the inner value is still
        // validated, so a quoted payload is rejected rather than unwrapped.
        assert!(build_command(&params("x (#a; rm -rf /)", "hi", None)).is_err());
        assert!(build_command(&params("#$(id)", "hi", None)).is_err());
    }

    #[test]
    fn rejects_overlong_channel() {
        assert!(build_command(&params(&"a".repeat(65), "hi", None)).is_err());
    }
}
