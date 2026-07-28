use super::*;

/// Regression guard: playback decoration happens after speed processing, so
/// the fixed device cushion is never time-stretched.
#[test]
fn playback_speed_preserves_production_sentence_lead_in() {
    let processed = process_complete_chunk(&vec![0.5; 2_400], 1.5, SAMPLE_RATE)
        .expect("process synthesized model audio");
    let mut first = true;
    let processed =
        build_sentence_append_buffer(&mut first, processed, 2_400, true, true);

    assert_eq!(SENTENCE_LEAD_IN_SAMPLES, 480);
    assert!(
        processed[..SENTENCE_LEAD_IN_SAMPLES]
            .iter()
            .all(|&sample| sample == 0.0),
        "the fixed device cushion must remain pure zero"
    );
    assert!(
        processed[SENTENCE_LEAD_IN_SAMPLES..]
            .iter()
            .any(|sample| sample.abs() > 0.1),
        "speech energy must remain after the fixed device cushion"
    );
}
