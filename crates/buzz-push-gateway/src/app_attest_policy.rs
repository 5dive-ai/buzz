//! Selects the production Apple verifier or the feature-gated development stub.

use crate::app_attest::{
    AppAttestError, AppAttestVerifier, VerifiedAssertion, VerifiedAttestation,
};

#[cfg_attr(
    not(feature = "dev-app-attest-bypass"),
    doc = r#"
The development policy is structurally unavailable in default builds:

```compile_fail
use buzz_push_gateway::app_attest_policy::AppAttestPolicy;

let _ = AppAttestPolicy::Development;
```
"#
)]
#[derive(Clone)]
pub enum AppAttestPolicy {
    Apple(AppAttestVerifier),
    #[cfg(feature = "dev-app-attest-bypass")]
    Development,
}

impl AppAttestPolicy {
    pub fn apple(verifier: AppAttestVerifier) -> Self {
        Self::Apple(verifier)
    }

    #[cfg(feature = "dev-app-attest-bypass")]
    pub fn development() -> Self {
        Self::Development
    }

    pub fn verify_attestation(
        &self,
        attestation_b64: &str,
        key_id_b64: &str,
        client_data: &[u8],
    ) -> Result<VerifiedAttestation, AppAttestError> {
        match self {
            Self::Apple(verifier) => {
                verifier.verify_attestation(attestation_b64, key_id_b64, client_data)
            }
            #[cfg(feature = "dev-app-attest-bypass")]
            Self::Development => {
                crate::dev_app_attest::verify_attestation(attestation_b64, key_id_b64, client_data)
            }
        }
    }

    pub fn verify_assertion(
        &self,
        assertion_b64: &str,
        client_data: &[u8],
        public_key: &[u8],
        previous_counter: u32,
        challenge: &str,
        stored_challenge: &str,
    ) -> Result<VerifiedAssertion, AppAttestError> {
        match self {
            Self::Apple(verifier) => verifier.verify_assertion(
                assertion_b64,
                client_data,
                public_key,
                previous_counter,
                challenge,
                stored_challenge,
            ),
            #[cfg(feature = "dev-app-attest-bypass")]
            Self::Development => crate::dev_app_attest::verify_assertion(
                assertion_b64,
                client_data,
                public_key,
                previous_counter,
                challenge,
                stored_challenge,
            ),
        }
    }
}
