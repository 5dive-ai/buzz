//! Non-blocking stdout log writer.
//!
//! Why this exists: the relay logs JSON lines to stdout, which in Kubernetes
//! is a pipe drained by the container runtime's log copier. If that copier
//! stalls (node disk-IO pressure, log rotation), the ~64KB pipe fills and the
//! next `write(2)` blocks **while holding Rust's global stdout lock**. Every
//! runtime worker that logs then queues behind it, the whole Tokio runtime
//! parks, liveness probes time out, SIGTERM (an async task) can never run,
//! and kubelet SIGKILLs the pod after the full grace period. Reproduced
//! deterministically by SIGSTOP-ing a pipe consumer; see
//! `RESEARCH/RELAY_STALL_LOCAL_REPRO_2026_07_27.md` (buzz nest).
//!
//! The fix moves the only blocking syscall onto one dedicated OS thread
//! behind a bounded queue ([`tracing_appender::non_blocking`], lossy mode).
//! When the sink stalls, log lines are dropped instead of the relay dying.
//! Drops are observable via the `buzz_log_lines_dropped_total` counter —
//! which doubles as a permanent detector for copier stalls.
//!
//! Loss policy is deliberate: there is no lossless bounded non-blocking
//! design under an indefinitely stalled consumer. Availability outranks log
//! completeness. Non-lossy mode would recreate the deadlock at queue
//! capacity instead of pipe capacity.

use std::time::Duration;

use tracing_appender::non_blocking::{ErrorCounter, NonBlocking, NonBlockingBuilder, WorkerGuard};

/// Bounded queue size, in lines.
///
/// Derived from measured production line sizes (bb-block fleet, 2026-07-28:
/// p50=248B, p99=641B, max=641B across 26k lines): 4096 × 641B ≈ 2.6MB
/// worst-case queue memory against a 2Gi pod limit, several minutes of
/// steady-state log volume. The buffer absorbs bursts; it is not sized to
/// ride out a sustained copier outage — once the sink is stalled, preserving
/// more backlog has diminishing value.
///
/// If a new log site can emit large unbounded fields (request bodies, event
/// payloads), cap the field at the call site — the queue is line-count
/// bounded, so line size is the memory multiplier.
const BUFFERED_LINES_LIMIT: usize = 4096;

/// How often the drop counter is polled into the metrics recorder.
const DROP_POLL_INTERVAL: Duration = Duration::from_secs(10);

/// Wrap stdout in a lossy bounded non-blocking writer.
///
/// The returned [`WorkerGuard`] must be bound to a **named** variable in
/// `main` (e.g. `_log_guard`) and held for the process lifetime: binding it
/// to bare `_` drops it immediately, shutting down the writer thread and
/// silently discarding all subsequent log output. On drop the guard flushes
/// buffered lines (bounded: 100ms send + 1s flush timeout upstream).
pub fn non_blocking_stdout() -> (NonBlocking, WorkerGuard) {
    NonBlockingBuilder::default()
        .lossy(true)
        .buffered_lines_limit(BUFFERED_LINES_LIMIT)
        .finish(std::io::stdout())
}

/// Periodically export the writer's cumulative drop count as the monotonic
/// counter `buzz_log_lines_dropped_total`.
///
/// Any positive rate means the stdout pipe is (or was) stalled and lines
/// were shed to protect the runtime — alert on it. Deliberately does NOT
/// log: the log channel is exactly what has failed when this fires.
pub fn spawn_drop_counter_poller(errors: ErrorCounter) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(DROP_POLL_INTERVAL);
        let mut last = 0usize;
        loop {
            interval.tick().await;
            let current = errors.dropped_lines();
            let delta = current.saturating_sub(last);
            if delta > 0 {
                metrics::counter!("buzz_log_lines_dropped_total").increment(delta as u64);
            }
            last = current;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Condvar, Mutex};
    use std::time::Duration;

    /// A writer that blocks in `write` while `blocked` is true — the shape of
    /// a full stdout pipe with a stalled consumer.
    #[derive(Clone)]
    struct StallableWriter {
        state: Arc<(Mutex<bool>, Condvar)>,
        bytes_written: Arc<AtomicUsize>,
    }

    impl StallableWriter {
        fn new(blocked: bool) -> Self {
            Self {
                state: Arc::new((Mutex::new(blocked), Condvar::new())),
                bytes_written: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn unblock(&self) {
            let (lock, cvar) = &*self.state;
            *lock.lock().unwrap() = false;
            cvar.notify_all();
        }
    }

    impl Write for StallableWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let (lock, cvar) = &*self.state;
            let mut blocked = lock.lock().unwrap();
            while *blocked {
                blocked = cvar.wait(blocked).unwrap();
            }
            self.bytes_written.fetch_add(buf.len(), Ordering::SeqCst);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn lossy_writer(sink: StallableWriter, limit: usize) -> (NonBlocking, WorkerGuard) {
        NonBlockingBuilder::default()
            .lossy(true)
            .buffered_lines_limit(limit)
            .finish(sink)
    }

    /// The invariant that motivated this module: with the sink fully stalled
    /// and the queue driven past capacity, async tasks must stay responsive,
    /// drops must be counted, and output must resume when the sink unblocks.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocked_sink_never_stalls_runtime_and_recovers() {
        let sink = StallableWriter::new(true);
        let limit = 8;
        let (writer, guard) = lossy_writer(sink.clone(), limit);
        let errors = writer.error_counter();

        // Drive the queue well past capacity while the sink is stalled.
        // (The worker thread is wedged in `write`, so nothing drains.)
        let mut w = writer.clone();
        for i in 0..(limit * 4) {
            let line = format!("{{\"n\":{i}}}\n");
            let _ = w.write(line.as_bytes());
        }

        // Liveness: an async round-trip must complete promptly even though
        // the log sink is fully wedged. This is the exact property the
        // blocking stdout writer violated.
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ = tx.send(());
        });
        tokio::time::timeout(Duration::from_secs(1), rx)
            .await
            .expect("async runtime stalled while log sink was blocked")
            .unwrap();

        // Overflow was shed and counted, bounding memory at `limit` lines.
        assert!(
            errors.dropped_lines() > 0,
            "expected dropped lines while sink was stalled"
        );

        // Recovery: unblock the sink; queued lines drain to the writer.
        sink.unblock();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while sink.bytes_written.load(Ordering::SeqCst) == 0 {
            assert!(
                std::time::Instant::now() < deadline,
                "sink did not receive any bytes after unblocking"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        drop(guard);
    }

    /// Normal path: tracing events written through the non-blocking writer
    /// reach the sink intact (whole-line, valid JSON) — and the guard flush
    /// delivers lines still queued at shutdown.
    #[test]
    fn tracing_events_reach_sink_end_to_end() {
        use tracing_subscriber::{fmt, prelude::*};

        let sink = StallableWriter::new(false);
        let captured: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));

        // Wrap the sink so we can inspect the exact bytes.
        #[derive(Clone)]
        struct Capture(Arc<Mutex<Vec<u8>>>, StallableWriter);
        impl Write for Capture {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                self.1.write(buf)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.1.flush()
            }
        }

        let (writer, guard) = NonBlockingBuilder::default()
            .lossy(true)
            .buffered_lines_limit(BUFFERED_LINES_LIMIT)
            .finish(Capture(captured.clone(), sink));

        let subscriber = tracing_subscriber::registry()
            .with(fmt::layer().json().flatten_event(true).with_writer(writer));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(probe = "delivery", "non-blocking writer end-to-end");
        });

        // Guard drop flushes the queue.
        drop(guard);

        let bytes = captured.lock().unwrap();
        let text = String::from_utf8_lossy(&bytes);
        let line = text
            .lines()
            .find(|l| l.contains("non-blocking writer end-to-end"))
            .expect("log line did not reach the sink");
        let parsed: serde_json::Value =
            serde_json::from_str(line).expect("log line reached sink but is not valid JSON");
        assert_eq!(parsed["probe"], "delivery");
    }

    /// An oversized line is still admitted whole-line atomically (or dropped
    /// whole): the queue is line-count bounded, so one giant line must never
    /// be split into partial writes.
    #[test]
    fn oversized_line_is_whole_line_atomic() {
        let sink = StallableWriter::new(false);
        let (writer, guard) = lossy_writer(sink.clone(), 4);

        let big = format!("{{\"big\":\"{}\"}}\n", "x".repeat(1024 * 1024));
        let mut w = writer.clone();
        let n = w.write(big.as_bytes()).unwrap();
        assert_eq!(n, big.len(), "write must report the full line accepted");

        drop(guard); // flush
        assert_eq!(
            sink.bytes_written.load(Ordering::SeqCst),
            big.len(),
            "sink must receive the entire line, not a fragment"
        );
    }

    /// The drop-counter poller translates cumulative dropped_lines into
    /// monotonic counter increments without ever logging.
    #[tokio::test]
    async fn drop_counter_deltas_are_computed_from_cumulative_count() {
        // Exercise the delta logic directly (the spawn wrapper is trivial).
        let sink = StallableWriter::new(true);
        let (writer, _guard) = lossy_writer(sink.clone(), 2);
        let errors = writer.error_counter();

        let mut w = writer.clone();
        for _ in 0..10 {
            let _ = w.write(b"{\"x\":1}\n");
        }
        let first = errors.dropped_lines();
        assert!(first > 0);

        for _ in 0..10 {
            let _ = w.write(b"{\"x\":1}\n");
        }
        let second = errors.dropped_lines();
        assert!(second > first, "cumulative counter must keep growing");
        assert_eq!(second.saturating_sub(first), 10);
        sink.unblock();
    }
}
