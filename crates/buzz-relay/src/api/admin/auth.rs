use axum::http::{header, HeaderMap};
use base64::Engine as _;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use super::error::ApiError;
use crate::state::AppState;

pub(crate) fn is_admin_host(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(config) = state.config.admin.as_ref() else {
        return false;
    };
    headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|host| host == config.host)
}

pub fn authorize(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let config = state
        .config
        .admin
        .as_ref()
        .ok_or_else(ApiError::not_found)?;
    if !is_admin_host(state, headers) {
        return Err(ApiError::forbidden());
    }
    if headers.get(header::ORIGIN).is_some_and(|origin| {
        origin
            .to_str()
            .map_or(true, |origin| !origin_matches_host(origin, &config.host))
    }) {
        return Err(ApiError::forbidden());
    }
    if !has_valid_credentials(headers, &config.credential_digest) {
        return Err(ApiError::unauthorized());
    }
    Ok(())
}

fn has_valid_credentials(headers: &HeaderMap, expected_digest: &[u8; 32]) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Some((scheme, encoded)) = value.split_once(' ') else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("basic") || encoded.is_empty() {
        return false;
    }
    let Ok(actual) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return false;
    };
    let actual_digest: [u8; 32] = Sha256::digest(&actual).into();
    bool::from(actual_digest.ct_eq(expected_digest))
}

fn origin_matches_host(origin: &str, host: &str) -> bool {
    origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        == Some(host)
}

#[cfg(test)]
mod tests {
    use super::{has_valid_credentials, origin_matches_host};
    use axum::http::{header, HeaderMap, HeaderValue};
    use base64::Engine as _;

    #[test]
    fn browser_origin_must_match_admin_host() {
        assert!(origin_matches_host(
            "https://admin.example.com",
            "admin.example.com"
        ));
        assert!(origin_matches_host(
            "http://admin.localhost:3000",
            "admin.localhost:3000"
        ));
        assert!(!origin_matches_host(
            "https://attacker.example",
            "admin.example.com"
        ));
        assert!(!origin_matches_host("null", "admin.example.com"));
    }

    #[test]
    fn admin_credentials_are_required_and_compared_exactly() {
        let encoded = base64::engine::general_purpose::STANDARD.encode("operator:correct secret");
        let expected = crate::config::AdminConfig::credential_digest("operator", "correct secret");
        let mut headers = HeaderMap::new();
        assert!(!has_valid_credentials(&headers, &expected));

        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Basic {encoded}")).expect("valid header"),
        );
        assert!(has_valid_credentials(&headers, &expected));
        let wrong = crate::config::AdminConfig::credential_digest("operator", "wrong secret");
        assert!(!has_valid_credentials(&headers, &wrong));
    }
}
