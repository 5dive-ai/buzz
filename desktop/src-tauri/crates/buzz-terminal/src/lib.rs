//! Terminal engine for the Buzz substrate.
//!
//! Owns the emulator: grid state, the parser, the two hardening fences, and
//! the damage encoding the renderer consumes. It does **not** own the PTY, the
//! child process, or the transport — those are the embedder's, so this crate
//! stays testable against byte fixtures with no process and no window.

pub mod context;
pub mod damage;
pub mod env_fence;
pub mod fences;
pub mod lifecycle;
pub mod listener;
pub mod path;
pub mod reader;
pub mod shared;
pub mod shell;
pub mod units;

#[cfg(test)]
mod context_tests;
#[cfg(test)]
mod env_fence_tests;
#[cfg(test)]
mod lifecycle_tests;

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Osc52, Term};
use alacritty_terminal::vte::ansi::CursorStyle;

pub use fences::{FenceStats, Fences};
pub use listener::{Action, Listener};
pub use shared::{AcquireMeter, AcquireStats, SharedTerminal};

/// Which grid a frame or a resize refers to.
///
/// Generation and dimensions travel together as one value because they answer
/// one question -- "is this the grid I am currently showing?" -- and a consumer
/// that compares them field by field can compare two of the three and be wrong
/// on a resize that changes only the one it skipped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Viewport {
    /// Advances on every *applied* resize. A same-size resize is inert and
    /// does not advance it, so an unchanged `ResizeObserver` tick cannot look
    /// like a discontinuity.
    pub generation: u64,
    pub columns: usize,
    pub screen_lines: usize,
}

/// Terminal dimensions in cells, plus how much scrollback to retain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub columns: usize,
    pub screen_lines: usize,
    pub scrollback: usize,
}

impl Default for Size {
    fn default() -> Self {
        Self {
            columns: 80,
            screen_lines: 24,
            scrollback: 10_000,
        }
    }
}

impl Dimensions for Size {
    fn total_lines(&self) -> usize {
        self.screen_lines + self.scrollback
    }

    fn screen_lines(&self) -> usize {
        self.screen_lines
    }

    fn columns(&self) -> usize {
        self.columns
    }
}

/// Build the emulator config.
///
/// Written as an explicit literal rather than `..Default::default()` so that
/// every security-relevant field is stated here and an upstream default change
/// cannot alter our posture silently. In particular `osc52` defaults to
/// `OnlyCopy` upstream, which would let terminal output write the user's
/// clipboard; we disable it outright.
pub fn config(size: Size) -> Config {
    Config {
        scrolling_history: size.scrollback,
        default_cursor_style: CursorStyle::default(),
        vi_mode_cursor_style: None,
        semantic_escape_chars: String::from(",│`|:\"' ()[]{}<>\t"),
        kitty_keyboard: false,
        osc52: Osc52::Disabled,
    }
}

/// A terminal: emulator state plus the fenced parser that drives it.
pub struct Terminal {
    term: Term<Listener>,
    feeder: reader::Feeder,
    size: Size,
    generation: u64,
}

impl Terminal {
    pub fn new(size: Size, fences: Fences) -> (Self, std::sync::mpsc::Receiver<Action>) {
        let (listener, actions) = Listener::new();
        let term = Term::new(config(size), &size, listener);
        (
            Self {
                term,
                feeder: reader::Feeder::new(
                    fences,
                    size.columns,
                    size.screen_lines,
                    size.scrollback,
                ),
                size,
                generation: 0,
            },
            actions,
        )
    }

    /// Feed PTY output through the fences into the emulator.
    ///
    /// Parses what one work budget affords and returns with the rest held as
    /// a pending tail, so one call cannot hold the terminal for an unbounded
    /// time. **The caller must pump [`Terminal::drain`] until it returns
    /// false**, releasing the lock between calls; that is the whole point --
    /// the tail exists to give the renderer a chance at the lock, not to defer
    /// work indefinitely. [`Terminal::pending_bytes`] and
    /// [`Terminal::tail_full`] tell the reader when to stop reading the PTY.
    pub fn feed(&mut self, bytes: &[u8]) -> bool {
        self.feeder.feed(&mut self.term, bytes)
    }

    /// Parse more of the pending tail. Returns whether any remains.
    pub fn drain(&mut self) -> bool {
        self.feeder.drain(&mut self.term);
        self.feeder.pending_bytes() > 0
    }

    /// Feed and parse to completion, without the intervening lock releases.
    ///
    /// For tests and for callers with no renderer contending -- it reinstates
    /// exactly the unbounded hold [`Terminal::feed`] exists to prevent, so it
    /// is deliberately a separate name rather than a flag on `feed`.
    pub fn feed_fully(&mut self, bytes: &[u8]) {
        self.feed(bytes);
        while self.drain() {}
    }

    /// Bytes accepted but not yet parsed.
    pub fn pending_bytes(&self) -> usize {
        self.feeder.pending_bytes()
    }

    /// Whether the tail is at its cap and the reader must stop reading.
    ///
    /// There is no production consumer today, deliberately: the desktop
    /// runtime pumps `drain()` to completion after every read, so the tail is
    /// empty between iterations. A future reader that defers pumping must
    /// consult this signal before accepting more PTY bytes.
    pub fn tail_full(&self) -> bool {
        self.feeder.tail_full()
    }

    /// Whether a paused reader may resume.
    pub fn tail_drained(&self) -> bool {
        self.feeder.tail_drained()
    }

    /// Discard the unparsed tail. Session close only -- see
    /// [`reader::Feeder::abandon_tail`].
    pub fn abandon_tail(&mut self) -> usize {
        self.feeder.abandon_tail()
    }

    pub fn stats(&self) -> FenceStats {
        self.feeder.stats()
    }

    pub fn reset_stats(&mut self) {
        self.feeder.reset_stats();
    }

    pub fn size(&self) -> Size {
        self.size
    }

    /// The grid as it stands now. Stamped onto each [`damage::Frame`] so a
    /// consumer can tell that a frame describes a *different* grid than the one
    /// it last drew, without having to infer it from message ordering.
    pub fn viewport(&self) -> Viewport {
        Viewport {
            generation: self.generation,
            columns: self.size.columns,
            screen_lines: self.size.screen_lines,
        }
    }

    /// Apply a new viewport.
    ///
    /// Takes one target size, never a stream of them: resize is superlinear in
    /// scrollback (2.5-4.7 ms per single column change at 10k history, and 40
    /// sequential 1-column steps cost 7.4x their coalesced equivalent), and it
    /// runs while holding the terminal. Coalescing is the caller's job; this
    /// function's job is to make the result observable.
    ///
    /// A resize forces a full damage frame -- upstream's `TermDamageState`
    /// sets `full` in its own `resize` (`term/mod.rs:240`) -- which is what
    /// keeps the encoder's per-line hashes from suppressing reflowed content.
    /// The generation bump is belt-and-braces on top of that: it lets the
    /// consumer *verify* it received the discontinuity rather than assume it.
    ///
    /// Returns the viewport that is now in effect, which is not necessarily the
    /// one requested: a same-size call is inert and returns the current
    /// generation unchanged. Returning it here rather than making the caller
    /// ask afterwards matters across a transport -- a follow-up query races the
    /// next resize, so the answer could describe a grid that had already been
    /// replaced by the time it was read.
    pub fn resize(&mut self, size: Size) -> Viewport {
        if size == self.size {
            return self.viewport();
        }
        self.term.resize(size);
        self.feeder.resize(size);
        self.size = size;
        self.generation += 1;
        self.viewport()
    }

    pub fn term(&self) -> &Term<Listener> {
        &self.term
    }

    pub fn term_mut(&mut self) -> &mut Term<Listener> {
        &mut self.term
    }
}
