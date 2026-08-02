//! Turning grid changes into frames for the renderer.
//!
//! Two rules shape this module, both measured:
//!
//! 1. **Nothing but reading and copying happens under the `Term` lock.** The
//!    caller copies rows out; encoding, hashing and serializing run after the
//!    lock is released. Encoding inline costs ~75x in lock hold.
//! 2. **Damage over-reports.** `Term::damage()` marks the cursor line every
//!    call, so an idle terminal reports damage nearly every frame. Per-line
//!    content hashing suppresses those, so the transport never sees a no-op.
//!
//! # Why a frame is the whole viewport
//!
//! Nearly every frame is a full repaint: `Term::scroll_up_relative` calls
//! `mark_fully_damaged()` unconditionally, so any output reaching the bottom
//! row damages the whole grid. Partial damage is effectively the idle cursor.
//!
//! That is fine, and the reason is worth having here rather than in a review
//! thread. A full frame is O(viewport) *by construction* -- the grid is itself
//! the coalescing buffer -- so its cost does not depend on how fast the child
//! writes. Measured on a 200x50 grid, bytes per frame across four orders of
//! magnitude of output rate: 11,390 at an unthrottled flood (45,759 lines
//! scrolled per frame), 11,390 at ~1 MB/s, 11,390 at ~100 KB/s, 11,305 on a
//! slow build log. Constant to three digits.
//!
//! A scroll-aware diff inverts that: its cost is O(lines scrolled), unbounded,
//! and at 45,759 lines/frame it would ship ~915x more data than the full grid
//! it was optimising. It wins where nobody is watching and loses under `cat`.
//!
//! **Revisit if the viewport grows.** 80x24 costs 2.6 KB/frame (0.2 MB/s at
//! 60 Hz), 200x50 costs 11.4 KB (0.7 MB/s), 400x100 costs 42.8 KB (2.6 MB/s).
//! 400x100 is roughly 4x a typical maximised window and is where this decision
//! should be re-measured -- as a serialization/IPC question, not a damage one.
//!
//! Dedup earns its place in the interactive case rather than the streaming one:
//! typing is ~0.9 rows per keystroke, and an idle terminal ships 0 rows across
//! 60 frames instead of a cursor-line frame 60x/second. Idle is the load-bearing
//! one -- it is what the substrate does while sitting behind the GUI untouched.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::TermDamage;

/// A run of cells sharing one visual style.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    /// First column of the run.
    pub column: usize,
    /// The run's text. Grapheme clusters are kept whole: a cell's zerowidth
    /// combining marks follow its base character, so the renderer never sees
    /// a base and its accent as separate glyphs.
    pub text: String,
    /// Packed style: fg, bg, and attribute flags.
    pub style: Style,
}

/// Visual style of a span, as the renderer needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Style {
    pub fg: u32,
    pub bg: u32,
    pub flags: u16,
}

/// One changed row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowFrame {
    pub line: usize,
    pub spans: Vec<Span>,
}

/// The cursor, carried separately from row content.
///
/// Upstream damages the cursor's line on every `damage()` call. If the cursor
/// travelled inside the row payload, every frame would carry a row rewrite for
/// a caret that moved one column. As its own plane it costs a few bytes and
/// leaves row dedup free to suppress the row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorFrame {
    pub line: usize,
    pub column: usize,
    pub visible: bool,
}

/// One update for the renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub rows: Vec<RowFrame>,
    pub cursor: CursorFrame,
    /// Whether the renderer should discard what it has and repaint.
    pub full: bool,
    /// The grid this frame describes. A change means the terminal was resized
    /// and row indices refer to a different geometry than the previous frame's.
    /// Carried so the consumer can detect that from the frame itself instead of
    /// trusting that no resize overtook it in flight -- across a transport, a
    /// frame captured before a resize can arrive after it.
    pub viewport: crate::Viewport,
}

impl Frame {
    /// True when there is nothing for the renderer to do.
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty() && !self.full
    }
}

/// Raw rows copied out from under the lock, awaiting encode.
pub struct RawFrame {
    rows: Vec<(usize, Vec<Cell>)>,
    cursor: CursorFrame,
    full: bool,
    viewport: crate::Viewport,
}

/// Copy the damaged rows out of the terminal. **Runs under the lock; does no
/// encoding.** Keep this function boring — everything added here is lock hold.
pub fn capture(terminal: &mut crate::Terminal) -> RawFrame {
    let viewport = terminal.viewport();
    let term = terminal.term_mut();
    let columns = term.columns();
    let screen_lines = term.screen_lines();
    let cursor_point = term.grid().cursor.point;
    let visible = term
        .mode()
        .contains(alacritty_terminal::term::TermMode::SHOW_CURSOR);

    let (lines, full) = match term.damage() {
        TermDamage::Full => ((0..screen_lines).collect::<Vec<_>>(), true),
        TermDamage::Partial(iter) => (
            iter.map(|bounds| bounds.line)
                .filter(|l| *l < screen_lines)
                .collect(),
            false,
        ),
    };

    let grid = term.grid();
    let mut rows = Vec::with_capacity(lines.len());
    for line in lines {
        let row = &grid[Line(line as i32)];
        rows.push((line, row[..Column(columns)].to_vec()));
    }
    let cursor = CursorFrame {
        line: cursor_point.line.0.max(0) as usize,
        column: cursor_point.column.0,
        visible,
    };

    term.reset_damage();
    RawFrame {
        rows,
        cursor,
        full,
        viewport,
    }
}

/// Suppresses rows whose content did not actually change.
#[derive(Default)]
pub struct Encoder {
    hashes: Vec<u64>,
}

impl Encoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Encode a captured frame. **Runs with the lock released.**
    pub fn encode(&mut self, raw: RawFrame) -> Frame {
        // A full frame invalidates the dedup cache. Both routes that produce
        // one matter: a `mark_fully_damaged` from scroll/alt-swap, and a resize,
        // where the cached hashes describe rows of a different width entirely.
        if raw.full {
            self.hashes.clear();
        }
        let mut rows = Vec::with_capacity(raw.rows.len());
        for (line, cells) in raw.rows {
            let hash = hash_cells(&cells);
            if self.hashes.len() <= line {
                self.hashes.resize(line + 1, 0);
            }
            if self.hashes[line] == hash {
                continue;
            }
            self.hashes[line] = hash;
            rows.push(RowFrame {
                line,
                spans: spans(&cells),
            });
        }
        Frame {
            rows,
            cursor: raw.cursor,
            full: raw.full,
            viewport: raw.viewport,
        }
    }
}

fn hash_cells(cells: &[Cell]) -> u64 {
    let mut hasher = DefaultHasher::new();
    for cell in cells {
        cell.c.hash(&mut hasher);
        // Hash the *packed* colors, not the enum: this is the representation
        // the renderer receives, so the dedup key cannot disagree with the
        // wire encoding and suppress a row that actually changed on screen.
        pack_color(cell.fg).hash(&mut hasher);
        pack_color(cell.bg).hash(&mut hasher);
        cell.flags.bits().hash(&mut hasher);
        if let Some(zerowidth) = cell.zerowidth() {
            zerowidth.hash(&mut hasher);
        }
    }
    hasher.finish()
}

/// Group a row's cells into styled runs.
fn spans(cells: &[Cell]) -> Vec<Span> {
    let mut spans: Vec<Span> = Vec::new();
    for (column, cell) in cells.iter().enumerate() {
        // A wide glyph occupies two cells: the character, then a spacer. The
        // spacer carries no text of its own -- emitting its placeholder space
        // would insert a phantom column after every CJK character or emoji.
        if cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
            continue;
        }
        let style = style_of(cell);
        let mut text = String::new();
        text.push(cell.c);
        if let Some(zerowidth) = cell.zerowidth() {
            text.extend(zerowidth);
        }
        match spans.last_mut() {
            Some(last) if last.style == style => last.text.push_str(&text),
            _ => spans.push(Span {
                column,
                text,
                style,
            }),
        }
    }
    spans
}

fn style_of(cell: &Cell) -> Style {
    Style {
        fg: pack_color(cell.fg),
        bg: pack_color(cell.bg),
        flags: cell.flags.bits(),
    }
}

/// Pack a color into a tagged u32 the renderer resolves against the theme.
///
/// Named and indexed colors stay symbolic rather than being resolved here:
/// the substrate must follow the user's chosen theme, so the palette belongs
/// to the renderer, not to a snapshot taken at damage time.
fn pack_color(color: alacritty_terminal::vte::ansi::Color) -> u32 {
    use alacritty_terminal::vte::ansi::Color;
    match color {
        Color::Named(named) => 0x0100_0000 | named as u32,
        Color::Indexed(index) => 0x0200_0000 | index as u32,
        Color::Spec(rgb) => {
            0x0300_0000 | ((rgb.r as u32) << 16) | ((rgb.g as u32) << 8) | rgb.b as u32
        }
    }
}
