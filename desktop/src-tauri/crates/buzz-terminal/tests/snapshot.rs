//! The attach contract: what a subscriber that arrives mid-stream is given,
//! and what taking it must not cost the subscriber already there.
//!
//! `render()` reports damage -- what changed since someone last looked. That
//! is the right thing for a steady-state renderer and the wrong thing for a
//! newcomer, who needs the screen as it stands. `snapshot()` supplies that,
//! and the delicate part is that it must do so *without* consuming damage:
//! two subscribers share one terminal, and damage is a single shared cursor.

use buzz_terminal::damage::Encoder;
use buzz_terminal::fences::Fences;
use buzz_terminal::{Action, SharedTerminal, Size, Terminal};
use std::sync::mpsc::Receiver;

/// The receiver is returned rather than dropped: dropping it disconnects the
/// channel and every subsequent listener send silently fails.
fn terminal(columns: usize, screen_lines: usize) -> (SharedTerminal, Receiver<Action>) {
    let size = Size {
        columns,
        screen_lines,
        scrollback: 100,
    };
    let (term, actions) = Terminal::new(size, Fences::ALL);
    (SharedTerminal::new(term), actions)
}

/// Collect the non-blank text of a frame's rows, for comparing what a
/// subscriber can actually see.
fn visible_text(frame: &buzz_terminal::damage::Frame) -> Vec<String> {
    frame
        .rows
        .iter()
        .map(|row| {
            row.spans
                .iter()
                .map(|span| span.text.as_str())
                .collect::<String>()
                .trim_end()
                .to_string()
        })
        .filter(|line| !line.is_empty())
        .collect()
}

/// The reason `snapshot` exists. A subscriber that attaches mid-stream and
/// starts from `render()` is handed only what changes next -- with a quiet
/// terminal that is the cursor's line alone, so the scrollback-visible screen
/// never arrives.
#[test]
fn a_late_render_shows_only_the_next_change_but_a_snapshot_shows_the_screen() {
    let (shared, _actions) = terminal(20, 4);
    shared.feed(b"first\r\nsecond\r\nthird");

    // The incumbent consumes the damage from that output.
    let mut incumbent = Encoder::new();
    let seen = visible_text(&shared.render(&mut incumbent));
    assert_eq!(seen, vec!["first", "second", "third"]);

    // A newcomer rendering now sees essentially nothing: damage is spent.
    let mut latecomer = Encoder::new();
    let by_render = visible_text(&shared.render(&mut latecomer));
    assert!(
        !by_render.contains(&"first".to_string()),
        "a late render cannot show scrollback it never saw damaged, got {by_render:?}"
    );

    // The same newcomer snapshotting sees the whole viewport.
    let mut attaching = Encoder::new();
    let by_snapshot = shared.snapshot(&mut attaching);
    assert_eq!(
        visible_text(&by_snapshot),
        vec!["first", "second", "third"],
        "a snapshot must carry the visible viewport"
    );
    assert!(by_snapshot.full, "a snapshot is a repaint");
}

/// **The law: `snapshot()` must not consume damage.**
///
/// Two subscribers share one terminal and damage is one shared cursor, so a
/// snapshot taken for an attaching subscriber must leave the incumbent's
/// pending rows intact. A naive implementation that calls `damage()` passes a
/// full-frame test while freezing every other subscriber -- the newcomer looks
/// perfect and the incumbent silently stops updating.
///
/// The interleaving is the point: write, snapshot, *then* let the incumbent
/// render. But the interleaving alone is not enough to discriminate, and the
/// reason is this module's own rule 2 -- `Term::damage()` marks the cursor
/// line on every call. So an incumbent owed only the line it is sitting on
/// gets that line back even when its damage was stolen, and a naive snapshot
/// passes.
///
/// The owed row therefore has to be somewhere the cursor is *not*. Here row 0
/// is rewritten and the cursor is parked on row 3, so a theft leaves the
/// incumbent holding a blank cursor line and nothing else.
#[test]
fn a_snapshot_does_not_steal_the_incumbents_damage() {
    let (shared, _actions) = terminal(20, 4);

    // An established renderer, caught up to a quiet terminal. The initial
    // content is shorter than its replacement so the rewrite below covers it
    // completely and no tail of it survives.
    let mut incumbent = Encoder::new();
    shared.feed(b"old");
    let _ = shared.render(&mut incumbent);

    // Rewrite row 0, then park the cursor on row 3. The incumbent is now owed
    // row 0, which is not the row the cursor will re-damage for free.
    shared.feed(b"\x1b[1;1HAFTER\x1b[4;1H");

    // A second subscriber attaches and snapshots first.
    let mut attaching = Encoder::new();
    let attached = shared.snapshot(&mut attaching);
    assert_eq!(
        visible_text(&attached),
        vec!["AFTER"],
        "the newcomer sees the whole screen"
    );

    // The incumbent must still be delivered row 0.
    let follow_up = shared.render(&mut incumbent);
    assert!(
        follow_up.rows.iter().any(|row| row.line == 0),
        "snapshot consumed the incumbent's damage: row 0 was never delivered, \
         got rows {:?}",
        follow_up.rows.iter().map(|r| r.line).collect::<Vec<_>>()
    );
    assert!(
        visible_text(&follow_up).contains(&"AFTER".to_string()),
        "the incumbent must still see the row written before the snapshot, got {:?}",
        visible_text(&follow_up)
    );
}

/// A snapshot stamps the geometry it was captured under and resets the
/// consumer's dedup state, so an encoder reused across a resize cannot carry
/// hashes describing rows of a different width.
#[test]
fn a_snapshot_realigns_a_reused_encoders_dedup_state() {
    let (shared, _actions) = terminal(20, 4);
    shared.feed(b"wide enough line");

    let mut encoder = Encoder::new();
    let before = shared.snapshot(&mut encoder);
    assert_eq!(before.viewport.columns, 20);

    let resized = shared.resize(Size {
        columns: 10,
        screen_lines: 4,
        scrollback: 100,
    });
    assert_eq!(resized.columns, 10);

    // Same encoder, new geometry: every row must be re-sent, not suppressed
    // as unchanged against hashes taken at the old width.
    let after = shared.snapshot(&mut encoder);
    assert_eq!(
        after.viewport.columns, 10,
        "the capture-time grid is stamped"
    );
    assert!(after.full, "a snapshot is a repaint");
    assert!(
        !after.rows.is_empty(),
        "stale hashes must not suppress rows after a resize"
    );
}

/// Two consecutive snapshots with no output between them still both carry the
/// screen. A snapshot is not a one-shot: reattach may happen repeatedly, and
/// nothing about the first may disarm the second.
#[test]
fn snapshots_are_repeatable() {
    let (shared, _actions) = terminal(20, 4);
    shared.feed(b"persistent");

    let mut first = Encoder::new();
    let mut second = Encoder::new();
    assert_eq!(
        visible_text(&shared.snapshot(&mut first)),
        vec!["persistent"]
    );
    assert_eq!(
        visible_text(&shared.snapshot(&mut second)),
        vec!["persistent"],
        "a second subscriber attaching later must see the same screen"
    );
}
