//! Fence enforcement around `vte`'s `Processor`.
//!
//! Everything that reaches the terminal's parser goes through [`Feeder::feed`].
//! It is the single place both fences are applied, so there is no route by
//! which bytes become parser-visible without being charged.

use alacritty_terminal::vte::ansi::{Handler, Processor, StdSyncHandler};

use crate::fences::{FenceStats, Fences, OSC_BUDGET, SYNC_CAP};

/// Owns the parser and enforces F1/F2 on every byte fed to it.
pub struct Feeder {
    parser: Processor<StdSyncHandler>,
    fences: Fences,
    stats: FenceStats,
    /// Bytes charged since the last F2 reset.
    since_reset: usize,
}

impl Feeder {
    pub fn new(fences: Fences) -> Self {
        Self {
            parser: Processor::new(),
            fences,
            stats: FenceStats::default(),
            since_reset: 0,
        }
    }

    pub fn stats(&self) -> FenceStats {
        self.stats
    }

    pub fn reset_stats(&mut self) {
        self.stats.reset();
    }

    /// Bytes currently buffered inside a synchronized update.
    pub fn pending_sync_bytes(&self) -> usize {
        self.parser.sync_bytes_count()
    }

    /// Feed one chunk of PTY output to the parser, applying both fences.
    pub fn feed<H: Handler>(&mut self, handler: &mut H, bytes: &[u8]) {
        let sync_before = self.parser.sync_bytes_count();
        self.parser.advance(handler, bytes);
        let sync_after = self.parser.sync_bytes_count();

        // Charge exactly the bytes the parser could see, by route:
        //
        // * the buffer shrank  -> a synchronized update ended and released
        //   `sync_before` buffered bytes plus whatever of `bytes` followed it.
        //   Charging only `bytes` here is the "omitted flush accounting"
        //   mutation: it under-charges by the whole buffered frame.
        // * the buffer grew    -> these bytes were swallowed into the buffer
        //   and are not yet parser-visible. Charging them now is the "raw
        //   counting" mutation: it over-charges, and resets the parser in the
        //   middle of a legitimate frame, destroying content.
        // * neither            -> ordinary unsynchronized input.
        let charged = if sync_after < sync_before {
            let released = sync_before + bytes.len() - sync_after;
            self.note_release(released);
            released
        } else if sync_after > sync_before {
            // Buffered, not yet visible. Charged when it is released.
            0
        } else {
            bytes.len()
        };
        self.charge(charged);

        // F1: a synchronized update may not buffer without bound. One abort
        // per breach; the released bytes are parser-visible and are charged.
        if self.fences.sync_abort && self.parser.sync_bytes_count() >= SYNC_CAP {
            let released = self.parser.sync_bytes_count();
            self.parser.stop_sync(handler);
            self.stats.sync_aborts += 1;
            self.note_release(released);
            self.charge(released);
        }

        // F2: rebuild the parser once the budget is spent. Unconditional --
        // a fresh `Processor` is the only way to discard parser state that a
        // hostile stream is holding open, and it must not depend on the
        // parser agreeing that it is in a bad state.
        if self.fences.osc_budget && self.since_reset >= OSC_BUDGET {
            self.parser = Processor::new();
            self.stats.osc_resets += 1;
            self.since_reset = 0;
        }
    }

    fn charge(&mut self, bytes: usize) {
        self.since_reset += bytes;
        self.stats.charged_bytes += bytes as u64;
    }

    fn note_release(&mut self, bytes: usize) {
        if bytes > self.stats.max_release {
            self.stats.max_release = bytes;
        }
    }
}
