//! The cluster-positioning contract: what the renderer may rely on to place
//! text at the right column without consulting Unicode tables.
//!
//! The consumer's rule reads two numbers off each span and does arithmetic:
//! `cluster_count == 1` means the whole text is one cluster at `column`,
//! otherwise cluster `i` is the i-th `char` at `column + i * width`.
//!
//! These fixtures exist because that rule is not self-evidently satisfiable --
//! the two cases below require *opposite* text-splitting rules, so no encoding
//! that ships a concatenated string and a start column can be correct:
//!
//! * a regional-indicator flag is two ordinary one-column cells, so its two
//!   codepoints occupy two columns and must split per codepoint;
//! * a keycap is one cell holding three codepoints, so it occupies one column
//!   and must split per grapheme.
//!
//! Both are handled here by construction rather than by rule: uniform `width`
//! within a span, and a span of its own for any cluster carrying zerowidth
//! marks.

use buzz_terminal::damage::{Encoder, Span};
use buzz_terminal::fences::Fences;
use buzz_terminal::{Action, SharedTerminal, Size, Terminal};
use std::sync::mpsc::Receiver;

/// The receiver is returned rather than dropped: dropping it disconnects the
/// channel and every subsequent listener send silently fails.
fn render(input: &str) -> (Vec<Span>, Receiver<Action>) {
    let size = Size {
        columns: 20,
        screen_lines: 2,
        scrollback: 100,
    };
    let (term, actions) = Terminal::new(size, Fences::ALL);
    let shared = SharedTerminal::new(term);
    shared.feed(input.as_bytes());
    let mut encoder = Encoder::new();
    let frame = shared.render(&mut encoder);
    let spans = frame
        .rows
        .into_iter()
        .find(|row| row.line == 0)
        .map(|row| row.spans)
        .unwrap_or_default();
    (spans, actions)
}

/// Apply the documented consumer rule and return `(column, cluster)` pairs,
/// dropping trailing blank padding.
///
/// This is the renderer's arithmetic, written out. Note what is *not* here: no
/// Unicode table, no zerowidth classifier, no grapheme segmentation. The
/// earlier draft of this helper carried a hand-rolled `is_zerowidth` matcher,
/// which is how we learned the encoding was under-specified -- if the fixture
/// needs a Unicode table to decode the wire, so does every real consumer.
fn placements(spans: &[Span]) -> Vec<(usize, String)> {
    let mut placed = Vec::new();
    for span in spans {
        assert!(
            span.counts_are_consistent(),
            "encoder emitted an undecodable span: {span:?}"
        );
        let clusters: Vec<String> = if span.cluster_count == 1 {
            vec![span.text.clone()]
        } else {
            span.text.chars().map(|c| c.to_string()).collect()
        };
        for (i, cluster) in clusters.into_iter().enumerate() {
            if cluster != " " {
                placed.push((span.column + i * span.width as usize, cluster));
            }
        }
    }
    placed
}

/// Max's case: mixed narrow and wide glyphs in one style. Every cluster must
/// land on the column the grid actually put it in.
#[test]
fn mixed_width_clusters_keep_their_columns() {
    let (spans, _actions) = render("a\u{1F600}b\u{4E00}c");
    assert_eq!(
        placements(&spans),
        vec![
            (0, "a".into()),
            (1, "\u{1F600}".into()),
            (3, "b".into()),
            (4, "\u{4E00}".into()),
            (6, "c".into()),
        ],
        "wide glyphs must advance two columns and narrow ones must not"
    );
}

/// A combining mark rides with its base character and consumes no column of
/// its own, so the text that follows must not be displaced by it.
///
/// Against the previous encoding this row was a single span `"éxy"` at column
/// 0, and a consumer stepping one column per `char` placed `x` at 1 and `y`
/// at 2 -- both one column left of the truth.
#[test]
fn combining_marks_do_not_displace_following_text() {
    let (spans, _actions) = render("e\u{0301}xy");
    assert_eq!(
        placements(&spans),
        vec![(0, "e\u{0301}".into()), (1, "x".into()), (2, "y".into()),],
        "a zerowidth mark must not consume a column"
    );
}

/// A regional-indicator pair: two separate one-column cells. This is the case
/// that must split *per codepoint*.
#[test]
fn regional_indicator_flag_occupies_two_columns() {
    let (spans, _actions) = render("\u{1F1FA}\u{1F1F8}X");
    assert_eq!(
        placements(&spans),
        vec![
            (0, "\u{1F1FA}".into()),
            (1, "\u{1F1F8}".into()),
            (2, "X".into()),
        ],
        "regional indicators are one column each; X must sit at 2"
    );
}

/// A keycap: one cell holding three codepoints. This is the case that must
/// split *per grapheme* -- the opposite rule from the flag above, which is why
/// the width and the cluster break both have to come from the grid.
#[test]
fn keycap_occupies_one_column() {
    let (spans, _actions) = render("1\u{FE0F}\u{20E3}X");
    assert_eq!(
        placements(&spans),
        vec![(0, "1\u{FE0F}\u{20E3}".into()), (1, "X".into()),],
        "a keycap is one column; X must sit at 1"
    );
}

/// Width is uniform within a span by construction. Without this a consumer
/// cannot multiply -- it would have to know each cluster's width individually,
/// which is the Unicode table this design exists to avoid.
#[test]
fn a_span_never_mixes_widths() {
    let (spans, _actions) = render("ab\u{4E00}\u{4E00}cd");
    for span in &spans {
        let expected = span.width;
        assert!(
            span.width == 1 || span.width == 2,
            "width must be 1 or 2, got {expected}"
        );
    }
    let widths: Vec<u8> = spans.iter().map(|s| s.width).collect();
    assert!(
        widths.contains(&2),
        "fixture must actually produce a wide span, got {widths:?}"
    );
    assert_eq!(
        placements(&spans),
        vec![
            (0, "a".into()),
            (1, "b".into()),
            (2, "\u{4E00}".into()),
            (4, "\u{4E00}".into()),
            (6, "c".into()),
            (7, "d".into()),
        ],
        "two adjacent wide glyphs must advance two columns each"
    );
}

/// `cluster_count` is what makes the wire decodable without a Unicode table,
/// so it is asserted directly here rather than only implied by placements.
///
/// The decisive pair: both spans below are width 1 with more than one `char`
/// of text, and they differ *only* in whether the count tracks the char count.
/// A consumer without that number cannot tell them apart -- which is the
/// defect Mari caught in the previous encoding.
#[test]
fn cluster_count_distinguishes_a_marked_cluster_from_a_plain_run() {
    let (marked, _a) = render("e\u{0301}");
    let marked = marked.first().expect("a span must be emitted");
    assert_eq!(marked.text.chars().count(), 2, "base plus combining mark");
    assert_eq!(marked.cluster_count, 1, "one cluster occupying one column");

    // The plain run absorbs the row's blank padding, so its length is the
    // viewport width rather than 2 -- what matters is that the count tracks
    // the char count instead of collapsing to 1.
    let (plain, _b) = render("ab");
    let plain = plain.first().expect("a span must be emitted");
    assert!(plain.cluster_count > 1, "a plain run is not one cluster");
    assert_eq!(
        usize::from(plain.cluster_count),
        plain.text.chars().count(),
        "one cluster per char"
    );

    assert_eq!(marked.width, plain.width, "both are width 1");
    assert!(marked.counts_are_consistent() && plain.counts_are_consistent());
}

/// Wrapping marks the last cell of the row with `WRAPLINE` (upstream
/// `term/mod.rs:968`). That bit records where the text happened to wrap, not
/// how the text looks, so it must not reach the style key: if it did, the last
/// column of every wrapped row would split off into a span of its own -- an
/// extra wire record per wrapped line, and span boundaries that move when the
/// window is resized.
///
/// Quinn found this by reading `cell.rs:21` while checking the `WIDE_CHAR`
/// mask; this fixture is the proof that was missing from the source read.
#[test]
fn wrapping_does_not_split_a_uniform_run() {
    let size = Size {
        columns: 5,
        screen_lines: 3,
        scrollback: 100,
    };
    let (term, _actions) = Terminal::new(size, Fences::ALL);
    let shared = SharedTerminal::new(term);
    // Six narrow cells in one style: five fill row 0 and set WRAPLINE on the
    // last of them, the sixth lands on row 1.
    shared.feed(b"abcdef");
    let mut encoder = Encoder::new();
    let frame = shared.render(&mut encoder);

    let first = frame
        .rows
        .iter()
        .find(|row| row.line == 0)
        .expect("wrapped row must be present");
    let texts: Vec<&str> = first.spans.iter().map(|s| s.text.as_str()).collect();
    assert_eq!(
        texts,
        vec!["abcde"],
        "a wrapped row of one style is one span; WRAPLINE must not break it"
    );
}

/// A wide glyph at the last usable column wraps to the next row rather than
/// straddling the edge. The contract must hold on the wrapped row too.
#[test]
fn leading_wide_glyph_after_wrap_is_positioned_from_column_zero() {
    let size = Size {
        columns: 5,
        screen_lines: 3,
        scrollback: 100,
    };
    let (term, _actions) = Terminal::new(size, Fences::ALL);
    let shared = SharedTerminal::new(term);
    // Four narrow cells fill 0..=3, leaving one column: the wide glyph cannot
    // fit and moves to the next row.
    shared.feed("abcd\u{4E00}".as_bytes());
    let mut encoder = Encoder::new();
    let frame = shared.render(&mut encoder);

    let second = frame
        .rows
        .iter()
        .find(|row| row.line == 1)
        .expect("wrapped row must be present");
    assert_eq!(
        placements(&second.spans),
        vec![(0, "\u{4E00}".into())],
        "a wrapped wide glyph starts at column 0 of the next row"
    );
}
