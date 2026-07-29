use super::FADE_OUT_SAMPLES;

/// Hard-clamp samples to ±1.0 full scale.
pub(super) fn clamp_to_full_scale(samples: Vec<f32>) -> Vec<f32> {
    samples.into_iter().map(|s| s.clamp(-1.0, 1.0)).collect()
}

/// Apply a short linear fade-out to avoid a discontinuity at playback boundaries.
pub(super) fn apply_fade_out(samples: &mut [f32]) {
    let len = samples.len();
    let fade = FADE_OUT_SAMPLES.min(len / 2);
    for i in 0..fade {
        samples[len - 1 - i] *= i as f32 / fade as f32;
    }
}

pub(super) fn group_sentences_into_chunks(sentences: &[String], max_chars: usize) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    for (index, sentence) in sentences.iter().enumerate() {
        let sentence = sentence.trim();
        if sentence.is_empty() {
            continue;
        }
        if index == 0 || chunks.is_empty() {
            chunks.push(sentence.to_string());
            continue;
        }
        let can_merge = chunks.len() > 1
            && chunks
                .last()
                .is_some_and(|chunk| chunk.len() + 1 + sentence.len() <= max_chars);
        if can_merge {
            if let Some(last) = chunks.last_mut() {
                last.push(' ');
                last.push_str(sentence);
            }
        } else {
            chunks.push(sentence.to_string());
        }
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grouped_sentences_keep_existing_latency_policy() {
        let sentences = vec!["First.".to_string(), "Second.".to_string()];
        assert_eq!(
            group_sentences_into_chunks(&sentences, 200),
            ["First.", "Second."]
        );
    }
}
