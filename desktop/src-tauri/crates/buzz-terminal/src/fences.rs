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

/// Max cost-weighted work one [`crate::reader::Feeder::drain`] may spend
/// before returning, in cell-equivalents.
///
/// Derived, not chosen: measured worst-case density across the 2-D op sweep
/// is 16.9 ns/work (`erase_chars` at N=1, 80x24 -- the cheapest real callback,
/// where fixed dispatch cost dominates the single cell it touches), so a
/// 16.67 ms frame is ~988_000 work units. This is a quarter of that. The
/// remaining three quarters are headroom for lock acquisition, the counting
/// wrapper's own bookkeeping, and platforms slower than the one measured;
/// 16.9 ns/work is the max of a sample, not a proven ceiling, so it is not
/// spent to the last unit.
pub const WORK_BUDGET: u64 = 250_000;

/// Bounds on how many bytes are handed to the parser at once.
///
/// The budget is checked *between* slices, so the slice is what actually
/// bounds one lock hold, and a fixed byte count cannot do it: `ESC#8` is
/// three bytes and costs a full grid, so 256 bytes of it is 1.6 ms at 200x50
/// and 14 ms at 1600x50. [`slice_bytes`] therefore derives the size from the
/// grid, and these two clamp it -- `MAX` at the throughput plateau (measured:
/// plain-char parsing saturates by 64 bytes and is flat to 64 KiB), `MIN`
/// where a slice stops being able to hold a whole escape sequence: 4 bytes
/// covers `ESC#8` and `ESC c` intact, so the floor never splits the densest
/// atoms across slices for no benefit. Measured throughput at the floor is
/// ~74% of the plateau on plain text and ~77% on SGR, which is the price of
/// bounding a grid whose worst atom exceeds the budget outright.
pub const MIN_SLICE: usize = 4;
pub const MAX_SLICE: usize = 256;

/// Bytes to hand the parser at once on a `columns x lines` grid.
///
/// Sized against the **densest atom the grid admits**, so the bound holds on
/// the first byte of a cold feeder for any payload: two bytes of `ESC c` buy
/// [`max_atom_work`], which is the most work per byte upstream offers, and
/// `budget / (atom / 2)` is the widest slice that cannot exceed one budget.
///
/// Deliberately *derived rather than learned*. An earlier version sized
/// slices from the density of preceding slices, which is strictly worse where
/// it matters: a fresh feeder has observed nothing, so its first slice is
/// wide, and a first wide slice of RIS spends many budgets before anything
/// looks. A bound that has to be taught is not a bound on the lesson.
///
/// [`MIN_SLICE`] floors it, and on any grid with real scrollback the floor is
/// what binds -- RIS at the default 10k depth is worth more than the entire
/// budget on its own, so no slice size can keep a drain inside the budget and
/// the floor stops the arithmetic from asking for fractions of a byte. That
/// residual is not hidden: it is exactly [`max_drain_work`], and it is the
/// honest cost of an indivisible callback that upstream can be asked to make
/// smaller only by not calling it.
pub fn slice_bytes(columns: usize, lines: usize, scrollback: usize) -> usize {
    let densest = (max_atom_work(columns, lines, scrollback) / 2).max(1);
    ((WORK_BUDGET / densest) as usize).clamp(MIN_SLICE, MAX_SLICE)
}

/// Bytes to hand the parser when `spent` of the budget is already gone.
///
/// The scheduling rule in one place so the fixtures can assert on it rather
/// than on a copy of the arithmetic: a slice of `N` bytes holds at most
/// `N / atom_bytes` atoms, so `remaining / densest` bytes cannot carry a
/// drain past the budget.
///
/// `next_escape` is how far the next `ESC` is from the front of the tail.
/// This is the difference between a correct bound and an unusable one. Only
/// an escape can buy grid-sized work in two bytes; a run of ordinary
/// characters costs at most `columns` per byte (a wrapping line feed that
/// scrolls), which is four orders of magnitude cheaper than RIS. Pricing
/// plain text as though every byte might be RIS drops throughput from
/// 181 MB/s to 69 MB/s at the default scrollback -- measured -- while
/// bounding something that cannot happen. So a plain run is sliced against
/// the plain-byte cost and only the escape itself is metered against the
/// worst atom.
pub fn slice_bytes_remaining(
    columns: usize,
    lines: usize,
    scrollback: usize,
    spent: u64,
    next_escape: usize,
) -> usize {
    let remaining = WORK_BUDGET.saturating_sub(spent);
    if next_escape > 0 {
        // A plain run, and it stops at the escape: an escape sharing a slice
        // with the text in front of it is how a callback runs *after* the one
        // that crossed the budget, which is the overrun this bound exists to
        // prevent. Worst case per plain byte is a line feed that scrolls,
        // which resets one row: `columns`.
        let per_byte = (columns as u64).max(1);
        return ((remaining / per_byte) as usize).clamp(1, next_escape.min(MAX_SLICE));
    }
    // An escape starts here. `ESC c` is the densest at two bytes.
    let densest = (max_atom_work(columns, lines, scrollback) / 2).max(1);
    ((remaining / densest) as usize).clamp(1, MAX_SLICE)
}

/// Work the single worst uninterruptible callback can cost on this grid.
///
/// This is the irreducible overrun past [`WORK_BUDGET`]: no scheduler outside
/// the parser can cut inside a callback, so a caller converting a work budget
/// into a time bound must add it.
///
/// It is `columns` because [`crate::units::Counting`] terminates CBT at its
/// first fixed point. Upstream's own loop is `N x columns` -- 82 ms for eight
/// bytes at 1600 columns -- and clamping `N` to `columns` only brings that to
/// `columns^2`, which at 1600 is 2.56M work, **10x the whole budget**: the
/// atom, not the budget, would decide the bound. Stopping at the fixed point
/// makes it `columns`, and the budget goes back to being the thing that sets
/// the bound. Every other callback is priced at or below `cells`, which is
/// larger, so this term never dominates.
pub fn max_atom_work(columns: usize, lines: usize, scrollback: usize) -> u64 {
    // RIS: both grids plus the primary's configured scrollback. This is the
    // largest single callback by a wide margin -- 16x the budget at the
    // default 10k depth -- and it is genuinely indivisible, so it is stated
    // rather than smoothed. CBT, once terminated at its fixed point, is
    // `columns` and never competes.
    //
    // Saturating, and widened to u64 *before* multiplying. `Size` fields are
    // unclamped `usize` with no caller bounding them, so the products here
    // are reachable overflows: in debug that is a panic in the accounting
    // path, and in release it wraps to a small number, which understates the
    // bound -- an overflow that reports the parser as cheap is the worst of
    // the three outcomes.
    let (columns, lines, scrollback) = (columns as u64, lines as u64, scrollback as u64);
    let both_grids = columns.saturating_mul(lines).saturating_mul(2);
    let history = scrollback.saturating_mul(columns);
    both_grids.saturating_add(history).max(columns)
}

/// Upper bound on the work a single [`crate::reader::Feeder::drain`] can do.
///
/// Two irreducible terms on top of [`WORK_BUDGET`], and it is worth being
/// exact about which is which, because I got this wrong first and the
/// fixtures caught it:
///
/// * The budget is checked *between* slices, so a drain overshoots by up to
///   one whole slice -- not one atom. [`slice_bytes`] keeps that under one
///   budget wherever its derivation is unclamped.
/// * A callback already running cannot be preempted. RIS at the default 10k
///   scrollback is worth 16x the whole budget on its own, so on such a grid
///   the floor binds and the overshoot is a few of those atoms. No scheduler
///   outside the parser can fix that -- what it can do is *report* it, which
///   is why this is a function callers can read rather than an assumption
///   they inherit.
pub fn max_drain_work(columns: usize, lines: usize, scrollback: usize) -> u64 {
    // One atom, not one slice: [`crate::reader::Feeder::drain`] sizes every
    // slice against the *remaining* budget, so it cannot start a slice able
    // to hold more work than is left. What it cannot do is preempt a callback
    // that has begun, which is where this term comes from.
    WORK_BUDGET.saturating_add(max_atom_work(columns, lines, scrollback))
}

/// Max bytes that may sit unparsed before the reader must stop reading the
/// PTY. Bounds the *queue*; [`WORK_BUDGET`] bounds only the lock hold.
pub const TAIL_CAP: usize = 4 << 20;

/// Depth at which a paused reader may resume. Strictly below [`TAIL_CAP`] so
/// the reader does not flap between full and one-byte-below-full.
pub const TAIL_RESUME: usize = 1 << 20;

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
    /// Parser units completed: one per `Handler` callback dispatched, which is
    /// one per fully-parsed escape sequence or printed character.
    ///
    /// Separate from `charged_bytes` because they answer different questions
    /// and can disagree by orders of magnitude: four bytes of `ESC#8` rewrite
    /// the whole grid, four bytes of `ESC[m` set a flag. Bytes bound memory;
    /// units are the proxy for time. See [`crate::units`].
    pub completed_units: u64,
    /// Cost-weighted work completed, in cell-equivalents: an O(cells) callback
    /// charges `columns * lines`, an O(1) callback charges 1.
    ///
    /// Deliberately a second number rather than a replacement for
    /// `completed_units`. They answer different questions -- "how many things
    /// happened" versus "how much did they cost" -- and a stream of `ESC#8`
    /// makes them disagree by four orders of magnitude, which is the entire
    /// reason this fence exists.
    pub completed_work: u64,
    /// Deepest the unparsed tail has been, in bytes. The high-water mark
    /// rather than the current depth, because the current depth is zero again
    /// by the time a test looks at it.
    pub max_pending: usize,
    /// Times the tail was at or over [`TAIL_CAP`] at the end of a drain.
    ///
    /// Loud on purpose. Reaching the cap means the reader kept reading past
    /// the point it was told to stop, so the queue bound is being held by
    /// nothing; a silent cap would make that indistinguishable from a reader
    /// that is obeying.
    pub tail_breaches: u64,
    /// Bytes discarded unparsed by [`crate::reader::Feeder::abandon_tail`].
    /// Non-zero anywhere but session close is a bug that ate output.
    pub abandoned_bytes: u64,
}

impl FenceStats {
    /// Clear all counters. Diagnostics are per-run; a gate that reads a
    /// counter accumulated across runs is asserting on the wrong thing.
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}
