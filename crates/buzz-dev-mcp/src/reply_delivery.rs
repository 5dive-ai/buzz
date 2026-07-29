use std::path::Path;
use std::sync::Mutex;

const STOP_OBJECTION: &str = "You have not posted your reply to Buzz. Do not describe or promise the send. Call the `shell` MCP tool now and run `buzz messages send`. Set `--channel` to the actual channel UUID from `[Context]` and `--content` to your reply; never use literal placeholder text. Do not end the turn until that command succeeds.";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum DeliveryStatus {
    #[default]
    AwaitingSend,
    Sent,
}

#[derive(Debug, Default)]
pub struct ReplyDeliveryState {
    status: Mutex<DeliveryStatus>,
}

impl ReplyDeliveryState {
    pub fn record_shell_result(&self, command: &str, exit_code: i32, stdout: &str) {
        let is_send = is_buzz_message_send(command);
        let accepted = write_was_accepted(stdout);
        if exit_code != 0 || !is_send || !accepted {
            return;
        }
        self.with_status(|status| *status = DeliveryStatus::Sent);
    }

    pub fn stop_objection(&self) -> String {
        self.with_status(|status| match status {
            DeliveryStatus::AwaitingSend => STOP_OBJECTION.to_owned(),
            DeliveryStatus::Sent => String::new(),
        })
    }

    pub fn reset_after_allowed_stop(&self) {
        self.with_status(|status| *status = DeliveryStatus::AwaitingSend);
    }

    fn with_status<R>(&self, f: impl FnOnce(&mut DeliveryStatus) -> R) -> R {
        let mut guard = match self.status.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        f(&mut guard)
    }
}

fn is_buzz_message_send(command: &str) -> bool {
    let mut words = command.split_ascii_whitespace();
    let Some(executable) = words.next() else {
        return false;
    };
    let executable = executable.trim_matches(['\'', '"']);
    let is_buzz = Path::new(executable)
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name, "buzz" | "buzz.exe"));
    is_buzz && words.next() == Some("messages") && words.next() == Some("send")
}

fn write_was_accepted(stdout: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(stdout.trim())
        .ok()
        .and_then(|value| value.get("accepted").and_then(serde_json::Value::as_bool))
        == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ACCEPTED: &str = r#"{"event_id":"abc","accepted":true,"message":"ok"}"#;

    #[test]
    fn successful_buzz_send_satisfies_stop_then_resets() {
        let state = ReplyDeliveryState::default();
        assert!(!state.stop_objection().is_empty());

        state.record_shell_result(
            "buzz messages send --channel c --content hello",
            0,
            ACCEPTED,
        );
        assert!(state.stop_objection().is_empty());

        state.reset_after_allowed_stop();
        assert!(!state.stop_objection().is_empty());
    }

    #[test]
    fn failed_or_rejected_send_does_not_satisfy_stop() {
        let state = ReplyDeliveryState::default();
        state.record_shell_result(
            "buzz messages send --channel c --content hello",
            1,
            ACCEPTED,
        );
        state.record_shell_result(
            "buzz messages send --channel c --content hello",
            0,
            r#"{"accepted":false}"#,
        );
        assert!(!state.stop_objection().is_empty());
    }

    #[test]
    fn mentioning_send_in_another_command_does_not_satisfy_stop() {
        let state = ReplyDeliveryState::default();
        state.record_shell_result("echo buzz messages send", 0, ACCEPTED);
        assert!(!state.stop_objection().is_empty());
    }

    #[test]
    fn absolute_buzz_path_is_recognized() {
        assert!(is_buzz_message_send(
            "/Applications/Buzz.app/Contents/MacOS/buzz messages send --channel c --content hi"
        ));
    }

    #[test]
    fn stop_objection_requires_the_shell_tool_and_successful_send() {
        assert!(STOP_OBJECTION.contains("`shell` MCP tool"));
        assert!(STOP_OBJECTION.contains("`buzz messages send`"));
        assert!(STOP_OBJECTION.contains("actual channel UUID"));
        assert!(STOP_OBJECTION.contains("never use literal placeholder"));
        assert!(STOP_OBJECTION.contains("command succeeds"));
    }
}
