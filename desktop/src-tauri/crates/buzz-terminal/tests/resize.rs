//! The resize seam: what a consumer is allowed to rely on across a reflow.
//!
//! The dedup encoder caches a hash per line. A resize reflows content into
//! rows of a different width, so those cached hashes describe a grid that no
//! longer exists -- if a resize did not force a full frame, dedup could
//! suppress a row whose content genuinely changed and leave the renderer
//! showing reflowed-away text.
//!
//! It does force one: upstream's `TermDamageState::resize` sets `full`
//! (`alacritty_terminal-0.26.0` term/mod.rs:240). These fixtures hold that
//! behaviour to the seam, because it is upstream's invariant and not ours.

use buzz_terminal::damage::Encoder;
use buzz_terminal::fences::Fences;
use buzz_terminal::{Action, SharedTerminal, Size, Terminal};
use std::sync::mpsc::Receiver;

/// The receiver is returned rather than dropped: dropping it disconnects the
/// channel, and every subsequent listener send silently fails. These fixtures
/// don't assert on actions, but a fixture that quietly disables a code path is
/// how a future assertion gets written against a dead one.
fn shared(size: Size) -> (SharedTerminal, Receiver<Action>) {
    let (term, actions) = Terminal::new(size, Fences::ALL);
    (SharedTerminal::new(term), actions)
}

fn size(columns: usize) -> Size {
    Size {
        columns,
        screen_lines: 10,
        scrollback: 1000,
    }
}

fn grid(columns: usize, screen_lines: usize) -> Size {
    Size {
        columns,
        screen_lines,
        scrollback: 1000,
    }
}

/// A resize invalidates dedup and republishes the whole grid at the new width.
#[test]
fn resize_forces_a_full_frame_at_the_new_width() {
    let (shared, _actions) = shared(size(40));
    let mut encoder = Encoder::new();
    shared.feed(b"\x1b[2J\x1b[Hhello world\r\nsecond line\r\n");

    let first = shared.render(&mut encoder);
    assert!(first.full, "first frame after a fresh Term must be full");
    assert_eq!(first.columns, 40);
    assert_eq!(first.generation, 0);

    // Nothing changed: dedup suppresses everything. Without this the next
    // assertion could pass simply because every frame is full.
    let idle = shared.render(&mut encoder);
    assert!(!idle.full, "an unchanged grid must not republish");
    assert!(
        idle.rows.is_empty(),
        "dedup let {} unchanged rows through",
        idle.rows.len()
    );

    shared.resize(size(20));
    let after = shared.render(&mut encoder);
    assert!(
        after.full,
        "a resize must invalidate the renderer's cached rows"
    );
    assert_eq!(
        after.columns, 20,
        "frame does not describe the new viewport"
    );
    assert_eq!(
        after.generation, 1,
        "generation must advance across a resize"
    );
    assert_eq!(after.rows.len(), 10, "full frame must carry every line");
    let row0: String = after.rows[0]
        .spans
        .iter()
        .map(|s| s.text.as_str())
        .collect();
    assert_eq!(row0.chars().count(), 20, "row emitted at the old width");
    assert!(
        row0.starts_with("hello world"),
        "content lost across reflow: {row0:?}"
    );
}

/// A no-op resize is not a resize: it must not burn a generation, or every
/// `ResizeObserver` tick would look like a discontinuity to the consumer.
#[test]
fn identical_resize_is_inert() {
    let (shared, _actions) = shared(size(40));
    let mut encoder = Encoder::new();
    shared.feed(b"hello");
    shared.render(&mut encoder);

    shared.resize(size(40));
    let after = shared.render(&mut encoder);
    assert_eq!(
        after.generation, 0,
        "a same-size resize advanced the generation"
    );
    assert!(
        !after.full,
        "a same-size resize forced a needless full repaint"
    );
}

/// A **full frame must carry every row**, including rows whose content is
/// byte-identical to what sat at that index before the resize.
///
/// This is the arm that catches a dedup cache surviving a full frame, and the
/// width-changing fixture above does *not* catch it: changing the width changes
/// every row's cell contents, so the hashes differ and the rows are emitted for
/// the wrong reason. A **height-only** resize keeps the width, so reflowed rows
/// hash exactly as before -- and a stale cache suppresses them right after the
/// consumer was told to discard what it had. The result is a renderer holding
/// nothing where content should be.
///
/// Verified concretely: growing 10 -> 20 lines moves "hello world" from row 0
/// to row 1, so correctness here is not merely about frame bookkeeping.
#[test]
fn full_frame_after_height_resize_republishes_unchanged_rows() {
    let (shared, _actions) = shared(grid(40, 10));
    let mut encoder = Encoder::new();
    shared.feed(b"\x1b[2J\x1b[Hhello world\r\nsecond line");
    let first = shared.render(&mut encoder);
    assert!(first.full);
    assert_eq!(first.rows.len(), 10);

    shared.resize(grid(40, 20));
    let after = shared.render(&mut encoder);
    assert!(
        after.full,
        "a resize must invalidate the renderer's cached rows"
    );
    assert_eq!(after.screen_lines, 20);
    assert_eq!(
        after.rows.len(),
        20,
        "full frame carried {} of 20 rows -- dedup suppressed rows the consumer \
         was simultaneously told to discard, leaving them blank",
        after.rows.len()
    );
}
