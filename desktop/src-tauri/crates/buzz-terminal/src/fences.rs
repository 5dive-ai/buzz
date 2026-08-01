//! The two hardening fences, and the counters that prove they ran.
//!
//! A hostile program can hold the parser's synchronized-update buffer open
//! (BSU without ESU) or an OSC string open, and upstream will buffer without
//! bound. Two independent fences, both enforced on **byte counts** — never on
//! a clock, because a clock makes the bound depend on how fast the machine is:
//!
//! * **F1** aborts a synchronized update once its buffer reaches [`SYNC_CAP`].
//! * **F2** rebuilds the parser once [`OSC_BUDGET`] parser-visible bytes have
//!   been charged without the parser returning to a clean state.
//!
//! F1 is also the interactive-latency fence. Without it a 2 MiB synchronized
//! frame releases into the parser in one call, holding the `Term` lock for
//! ~13 ms; with it the same frame arrives in 64 KiB pieces and renderer lock
//! acquisition drops from ~4.2 ms to ~29 us (146x). Deleting F1 regresses both
//! memory and latency.

/// Max bytes a synchronized update may buffer before it is aborted.
pub const SYNC_CAP: usize = 64 << 10;

/// Max parser-visible bytes chargeable before the parser is rebuilt.
pub const OSC_BUDGET: usize = 256 << 10;

/// Which fences are active. Both on in production.
///
/// The mutation law requires exercising each fence with the other **disabled**,
/// because F1's abort releases the sync buffer in small pieces and thereby
/// masks a miscounting F2. This is deliberately a runtime value and not a cargo
/// feature: a fence that can be compiled out is one more way for a gate to pass
/// green over code that never ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fences {
    /// F1: abort a synchronized update at [`SYNC_CAP`].
    pub sync_abort: bool,
    /// F2: rebuild the parser at [`OSC_BUDGET`].
    pub osc_budget: bool,
}

impl Default for Fences {
    fn default() -> Self {
        Self {
            sync_abort: true,
            osc_budget: true,
        }
    }
}

impl Fences {
    /// Production configuration: both fences enforced.
    pub const ALL: Self = Self {
        sync_abort: true,
        osc_budget: true,
    };
    /// F2 alone — the arm that can observe F2's counting, unmasked by F1.
    pub const OSC_ONLY: Self = Self {
        sync_abort: false,
        osc_budget: true,
    };
    /// F1 alone.
    pub const SYNC_ONLY: Self = Self {
        sync_abort: true,
        osc_budget: false,
    };
    /// Neither — the unfenced control that shows what upstream does alone.
    pub const NONE: Self = Self {
        sync_abort: false,
        osc_budget: false,
    };
}

/// Per-run fence observations. Every field is what some gate asserts on.
///
/// `charged_bytes` is deliberately separate from `osc_resets`: a deleted F2
/// shows up as `osc_resets == 0`, but an F2 that counts the *wrong* bytes
/// (omitting flush routes, or charging raw input) still resets — only the
/// charge total distinguishes those. One counter cannot see both mutations.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FenceStats {
    /// F1 aborts performed.
    pub sync_aborts: u64,
    /// Largest number of bytes released to the parser by a single flush,
    /// whether via an F1 abort or a legitimate end-of-update. This is the
    /// quantity that bounds one lock hold.
    pub max_release: usize,
    /// F2 parser rebuilds performed.
    pub osc_resets: u64,
    /// Parser-visible bytes charged against the F2 budget, cumulative across
    /// resets. Includes every flush route, not just directly-advanced input.
    pub charged_bytes: u64,
}

impl FenceStats {
    /// Clear all counters. Diagnostics are per-run; a gate that reads a
    /// counter accumulated across runs is asserting on the wrong thing.
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}
