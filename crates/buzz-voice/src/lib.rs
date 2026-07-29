//! Reusable local voice primitives for Buzz.

pub mod pocket;

pub use pocket::{
    load_text_to_speech, load_voice_style, PocketTts, SynthesisOutcome, VoiceStyle, DEFAULT_VOICE,
    SAMPLE_RATE, VOICE_FILE_EXT,
};

/// One immutable artifact required by the April Pocket bundle.
///
/// `filename` is the bundle-relative file name, `sha256` pins its contents,
/// `size_bytes` supports download progress and validation, and `quantized`
/// identifies the INT8 components.
pub type PocketModelArtifact = pocket::PocketModelArtifact;

/// Capabilities of Buzz Desktop's April Pocket model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PocketModelInfo {
    /// Language bundle selected from the pinned export.
    pub bundle_id: &'static str,
    /// Upstream model repository.
    pub source_model_id: &'static str,
    /// Pinned upstream model revision.
    pub revision: &'static str,
    /// PCM output sample rate.
    pub sample_rate: u32,
    /// Maximum input size declared by the bundle.
    pub max_token_per_chunk: usize,
    /// Immutable files required by the runtime.
    pub artifacts: &'static [PocketModelArtifact],
    /// Components quantized in the selected bundle.
    pub quantized_components: &'static [&'static str],
}

/// Language bundle selected from the pinned export.
pub const APRIL_BUNDLE_ID: &str = pocket::APRIL_BUNDLE_ID;
/// Pinned upstream export repository.
pub const APRIL_MODEL_ID: &str = pocket::APRIL_MODEL_ID;
/// Pinned revision containing the April bundle.
pub const APRIL_MODEL_REVISION: &str = pocket::APRIL_MODEL_REVISION;

/// Return immutable metadata for Buzz Desktop's April Pocket model.
pub const fn april_model_info() -> PocketModelInfo {
    let info = pocket::april_model_info();
    PocketModelInfo {
        bundle_id: info.bundle_id,
        source_model_id: info.source_model_id,
        revision: info.revision,
        sample_rate: info.sample_rate,
        max_token_per_chunk: info.max_token_per_chunk,
        artifacts: info.artifacts,
        quantized_components: info.quantized_components,
    }
}
