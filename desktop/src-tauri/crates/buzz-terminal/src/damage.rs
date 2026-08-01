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

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Term, TermDamage};

use crate::listener::Listener;

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
}

/// Copy the damaged rows out of the terminal. **Runs under the lock; does no
/// encoding.** Keep this function boring — everything added here is lock hold.
pub fn capture(term: &mut Term<Listener>) -> RawFrame {
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
    RawFrame { rows, cursor, full }
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
