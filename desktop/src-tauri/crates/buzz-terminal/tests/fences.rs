//! Fence behaviour against byte fixtures. No PTY, no process, no window --
//! these are pure functions of input bytes and run identically on every
//! platform.
//!
//! Per the mutation law, arms that can be masked by the *other* fence run with
//! that fence disabled. F1's abort releases a synchronized buffer in 64 KiB
//! pieces, which hides an F2 that charges the wrong bytes.

use buzz_terminal::fences::{Fences, OSC_BUDGET, SYNC_CAP};
use buzz_terminal::{Size, Terminal};

fn size() -> Size {
    Size {
        columns: 120,
        screen_lines: 40,
        scrollback: 2000,
    }
}

/// A hostile stream: open a synchronized update, then never close it.
fn unterminated_sync(total: usize, chunk: usize) -> Vec<Vec<u8>> {
    let mut chunks = vec![b"\x1b[?2026h".to_vec()];
    let mut sent = 0;
    while sent < total {
        chunks.push(vec![b'A'; chunk]);
        sent += chunk;
    }
    chunks
}

/// A legitimate frame: one synchronized update carrying `markers` findable
/// markers, closed properly.
fn legit_frame(markers: usize, per_marker: usize) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(b"\x1b[?2026h\x1b[2J\x1b[H");
    for marker in 0..markers {
        payload.extend_from_slice(format!("MK{marker:03}\r\n").as_bytes());
        let target = payload.len() + per_marker;
        while payload.len() < target {
            payload.extend_from_slice(b"\x1b[1;32mx\x1b[0m");
        }
        payload.extend_from_slice(b"\r\n");
    }
    payload.extend_from_slice(b"\x1b[?2026l");
    payload
}

fn count_markers(term: &Terminal, markers: usize) -> usize {
    use alacritty_terminal::grid::Dimensions;
    use alacritty_terminal::index::{Column, Line, Point};
    let grid = term.term().grid();
    let mut text = String::new();
    let top = -(grid.history_size() as i32);
    for line in top..term.size().screen_lines as i32 {
        for column in 0..term.size().columns {
            text.push(grid[Point::new(Line(line), Column(column))].c);
        }
        text.push('\n');
    }
    (0..markers)
        .filter(|m| text.contains(&format!("MK{m:03}")))
        .count()
}

/// G1: a synchronized update may not buffer without bound.
#[test]
fn g1_sync_abort_bounds_one_release() {
    let (mut term, _actions) = Terminal::new(size(), Fences::ALL);
    for chunk in unterminated_sync(8 << 20, 8192) {
        term.feed(&chunk);
    }
    let stats = term.stats();
    assert!(
        stats.sync_aborts > 0,
        "F1 never fired on an unterminated update"
    );
    // One chunk may arrive after the cap is reached but before the abort, so
    // the bound is the cap plus one read.
    assert!(
        stats.max_release <= SYNC_CAP + 8192,
        "single release of {} B exceeds the F1 bound",
        stats.max_release
    );
}

/// The unfenced control: without F1 the same stream releases in ~2 MiB gulps.
/// If this stops holding, `g1_sync_abort_bounds_one_release` proves nothing.
///
/// Note what is asserted: **peak release**, not the trailing buffer. vte caps
/// its own sync buffer at `SYNC_BUFFER_SIZE` (2 MiB, `vte-0.15.0` ansi.rs:39)
/// and self-flushes there, so the buffer is near-empty when the stream stops.
/// That upstream cap is the ~2 MiB residual the plan scopes to "F1 absent or
/// ineffective" -- it is a backstop 32x above our bound, not a substitute.
#[test]
fn g1_control_unfenced_releases_in_megabyte_gulps() {
    let (mut term, _actions) = Terminal::new(size(), Fences::NONE);
    for chunk in unterminated_sync(8 << 20, 8192) {
        term.feed(&chunk);
    }
    let stats = term.stats();
    assert_eq!(stats.sync_aborts, 0);
    assert!(
        stats.max_release > SYNC_CAP,
        "unfenced release peaked at {} B, inside the F1 bound; the fixture is not hostile \
         and the G1 assertion is vacuous",
        stats.max_release
    );
}

/// G2 arm 1: F2 fires on a hostile unsynchronized stream.
/// F1 is retained here on purpose -- this arm proves F2 *deletion* under the
/// combined production shape.
#[test]
fn g2_hostile_osc_triggers_reset() {
    let (mut term, _actions) = Terminal::new(size(), Fences::ALL);
    let mut chunks = vec![b"\x1b]0;".to_vec()];
    for _ in 0..256 {
        chunks.push(vec![b'A'; 8192]);
    }
    for chunk in &chunks {
        term.feed(chunk);
    }
    assert!(term.stats().osc_resets > 0, "F2 never rebuilt the parser");
}

/// G2 arm 2: charge accounting includes the flush route.
///
/// **F1 disabled** -- with it on, the abort releases the buffer in pieces that
/// are charged as ordinary input, so an F2 that ignores flushes still resets
/// and the arm cannot see the mutation.
#[test]
fn g2_flush_route_is_charged() {
    let (mut term, _actions) = Terminal::new(size(), Fences::OSC_ONLY);
    // Each frame buffers just under the budget, then releases it all at once.
    // The released bytes are parser-visible only at the ESU.
    let frame_bytes = OSC_BUDGET - (32 << 10);
    let frames = 8;
    for _ in 0..frames {
        term.feed(b"\x1b[?2026h");
        let mut sent = 0;
        while sent < frame_bytes {
            term.feed(&vec![b'A'; 8192]);
            sent += 8192;
        }
        term.feed(b"\x1b[?2026l");
    }
    let stats = term.stats();
    assert_eq!(
        stats.sync_aborts, 0,
        "F1 must be off for this arm to discriminate"
    );
    assert!(
        stats.charged_bytes >= (frames * frame_bytes) as u64,
        "charged {} B of {} B released through the flush route",
        stats.charged_bytes,
        frames * frame_bytes
    );
    assert!(
        stats.osc_resets > 0,
        "budget never spent: flush accounting omitted"
    );
}

/// G2 arm 3: a legitimate frame survives intact.
///
/// **F1 disabled** -- this is the arm that catches raw counting, and F1's
/// abort masks it by releasing the buffer before the raw count can overrun.
#[test]
fn g2_legitimate_frame_survives() {
    let markers = 200;
    let (mut term, _actions) = Terminal::new(size(), Fences::OSC_ONLY);
    for chunk in legit_frame(markers, 7853).chunks(8192) {
        term.feed(chunk);
    }
    assert_eq!(
        count_markers(&term, markers),
        markers,
        "content lost from a legitimate frame"
    );
}
