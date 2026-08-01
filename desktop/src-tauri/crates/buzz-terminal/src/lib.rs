//! Terminal engine for the Buzz substrate.
//!
//! Owns the emulator: grid state, the parser, the two hardening fences, and
//! the damage encoding the renderer consumes. It does **not** own the PTY, the
//! child process, or the transport — those are the embedder's, so this crate
//! stays testable against byte fixtures with no process and no window.

pub mod damage;
pub mod fences;
pub mod listener;
pub mod reader;
pub mod shared;

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::term::{Config, Osc52, Term};
use alacritty_terminal::vte::ansi::CursorStyle;

pub use fences::{FenceStats, Fences};
pub use listener::{Action, Listener};
pub use shared::{AcquireMeter, AcquireStats, SharedTerminal};

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
}

impl Terminal {
    pub fn new(size: Size, fences: Fences) -> (Self, std::sync::mpsc::Receiver<Action>) {
        let (listener, actions) = Listener::new();
        let term = Term::new(config(size), &size, listener);
        (
            Self {
                term,
                feeder: reader::Feeder::new(fences),
                size,
            },
            actions,
        )
    }

    /// Feed PTY output through the fences into the emulator.
    pub fn feed(&mut self, bytes: &[u8]) {
        self.feeder.feed(&mut self.term, bytes);
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

    pub fn term(&self) -> &Term<Listener> {
        &self.term
    }

    pub fn term_mut(&mut self) -> &mut Term<Listener> {
        &mut self.term
    }
}
