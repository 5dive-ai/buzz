//! Guards the one property that makes buzz-acp's turn lifecycle observable:
//! every custom tracing target in the crate must pass the default log filter.
//!
//! The binary installs `EnvFilter::new("buzz_acp=info")` when `RUST_LOG` is
//! unset (`src/lib.rs`), and Desktop hands its managed child the same filter.
//! `EnvFilter` matches a directive against a target by path-segment prefix, so
//! a bare target like `pool::prompt` is silently dropped by both — the turn
//! start and stop lines simply never appear, and a turn that produced nothing
//! leaves no trace to diagnose.

use std::io;
use std::sync::{Arc, Mutex};

use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::EnvFilter;

/// The filter both launch paths default to.
const DEFAULT_FILTER: &str = "buzz_acp=info";

#[derive(Clone, Default)]
struct CapturedLog(Arc<Mutex<Vec<u8>>>);

impl CapturedLog {
    fn contents(&self) -> String {
        String::from_utf8(self.0.lock().expect("log buffer poisoned").clone())
            .expect("log output is utf-8")
    }
}

impl io::Write for CapturedLog {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0
            .lock()
            .expect("log buffer poisoned")
            .extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for CapturedLog {
    type Writer = Self;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// Pins the prefix rule the rename relies on: under the default filter an
/// unprefixed target is dropped and a `buzz_acp::`-prefixed one is emitted.
/// If this ever stops holding, the rename below stops buying anything.
#[test]
fn test_default_filter_drops_unprefixed_targets_and_passes_prefixed_ones() {
    let captured = CapturedLog::default();
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new(DEFAULT_FILTER))
        .with_writer(captured.clone())
        .finish();

    tracing::subscriber::with_default(subscriber, || {
        tracing::info!(target: "pool::prompt", "unprefixed");
        tracing::info!(target: "buzz_acp::pool::prompt", "prefixed");
    });

    let output = captured.contents();
    assert!(
        !output.contains("unprefixed"),
        "a bare target must be dropped by {DEFAULT_FILTER} — got:\n{output}"
    );
    assert!(
        output.contains("prefixed"),
        "a buzz_acp:: target must pass {DEFAULT_FILTER} — got:\n{output}"
    );
}

/// Every `target:` literal in the crate must carry the prefix, so no log line
/// can be added that the shipped filter would swallow.
#[test]
fn test_every_tracing_target_in_the_crate_passes_the_default_filter() {
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders = Vec::new();

    for entry in std::fs::read_dir(&src).expect("crate src is readable") {
        let path = entry.expect("readable dir entry").path();
        if path.extension().is_none_or(|ext| ext != "rs") {
            continue;
        }
        let contents = std::fs::read_to_string(&path).expect("source file is utf-8");
        for (lineno, line) in contents.lines().enumerate() {
            let Some(rest) = line.split_once("target: \"") else {
                continue;
            };
            let target = rest.1.split('"').next().unwrap_or_default();
            if !target.starts_with("buzz_acp") {
                let file = path.file_name().unwrap_or_default().to_string_lossy();
                offenders.push(format!("{file}:{} target: \"{target}\"", lineno + 1));
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "these targets are invisible under {DEFAULT_FILTER}; prefix them with `buzz_acp::`:\n  {}",
        offenders.join("\n  ")
    );
}
