//! The `Buzz-Client` advisory identity header, shared by every Rust client.
//!
//! Buzz-owned servers cannot otherwise tell which application, platform, or
//! version a connection came from, which makes support triage, rollout
//! monitoring, and deprecation decisions guesswork. Each client sends a
//! [RFC 8941](https://www.rfc-editor.org/rfc/rfc8941) structured dictionary:
//!
//! ```text
//! Buzz-Client: v=1, app=buzz-desktop, platform=macos, app-version="0.5.2"
//! ```
//!
//! This module owns only the *sending* half: the canonical header name, the
//! app/platform vocabularies, and the serializer. The relay parses the header
//! with its own lenient reader (`buzz-relay`'s `client_info`) and treats it as
//! advisory — it never participates in authentication, authorization, or
//! tenant selection.
//!
//! # Privacy
//!
//! The field set is deliberately minimal: application, platform, and a
//! user-visible version. No device model, install identifier, timezone,
//! network type, or raw bundle ID. The header is sent only to the relay a
//! client is already configured to talk to, never to third-party origins, and
//! is never embedded in signed events.

use std::fmt::Write as _;

/// Canonical header name. Lowercase so it can be used directly as an HTTP/2
/// field name and compared against `http::HeaderName` without reallocating.
pub const CLIENT_HEADER: &str = "buzz-client";

/// Structured-dictionary format version. Bump only on a breaking field change;
/// the relay rejects any other value rather than guessing.
pub const CLIENT_HEADER_FORMAT_VERSION: i64 = 1;

/// The application sending a request, as an RFC 8941 token.
///
/// A closed vocabulary is the cardinality guard: these values become
/// Prometheus label values on the relay, so they must never derive from
/// free-form input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientApp {
    /// The Tauri desktop application.
    Desktop,
    /// The Flutter mobile application.
    Mobile,
    /// The `buzz` command-line interface.
    Cli,
    /// The agent harness that drives ACP runtimes.
    Acp,
}

impl ClientApp {
    /// The RFC 8941 token for this application.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "buzz-desktop",
            Self::Mobile => "buzz-mobile",
            Self::Cli => "buzz-cli",
            Self::Acp => "buzz-acp",
        }
    }

    /// Every known application token, for the relay's parse allowlist.
    #[must_use]
    pub const fn all() -> &'static [&'static str] {
        &["buzz-desktop", "buzz-mobile", "buzz-cli", "buzz-acp"]
    }
}

/// The operating-system family a client is running on, as an RFC 8941 token.
///
/// Deliberately coarse — the family only, never a kernel or build string.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientPlatform {
    /// Apple macOS.
    MacOs,
    /// Microsoft Windows.
    Windows,
    /// Linux, including the AppImage and `.deb` desktop builds.
    Linux,
    /// Apple iOS and iPadOS.
    Ios,
    /// Android.
    Android,
}

impl ClientPlatform {
    /// The RFC 8941 token for this platform.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::MacOs => "macos",
            Self::Windows => "windows",
            Self::Linux => "linux",
            Self::Ios => "ios",
            Self::Android => "android",
        }
    }

    /// Every known platform token, for the relay's parse allowlist.
    #[must_use]
    pub const fn all() -> &'static [&'static str] {
        &["macos", "windows", "linux", "ios", "android"]
    }

    /// The platform this binary was compiled for, or `None` on a target Buzz
    /// does not ship.
    ///
    /// Returning `None` rather than an `"other"` token keeps the vocabulary
    /// closed: an unshipped target simply sends no header and is counted as
    /// unidentified, instead of inventing a label value.
    #[must_use]
    pub fn current() -> Option<Self> {
        // `std::env::consts::OS` is fixed per compile target. Not a `const fn`
        // because `str` cannot be matched in const context.
        match std::env::consts::OS {
            "macos" => Some(Self::MacOs),
            "windows" => Some(Self::Windows),
            "linux" => Some(Self::Linux),
            "ios" => Some(Self::Ios),
            "android" => Some(Self::Android),
            _ => None,
        }
    }
}

/// Maximum serialized header length. A Buzz-generated value is far shorter;
/// this only bounds a pathological `app_version` before it reaches the wire.
const MAX_HEADER_LEN: usize = 256;

/// Longest accepted `app-version`, matching the relay's own bound.
const MAX_APP_VERSION_LEN: usize = 32;

/// Build the `Buzz-Client` header value for this client.
///
/// Returns `None` when the platform is not one Buzz ships, or when
/// `app_version` is empty or not a plausible version string. A missing header
/// is a supported state on the relay, so refusing to send is always safe —
/// callers must never substitute a placeholder.
///
/// # Examples
///
/// ```
/// use buzz_core::client_identity::{client_header_value, ClientApp, ClientPlatform};
///
/// let value = client_header_value(ClientApp::Desktop, ClientPlatform::MacOs, "0.5.2").unwrap();
/// assert_eq!(value, r#"v=1, app=buzz-desktop, platform=macos, app-version="0.5.2""#);
/// ```
#[must_use]
pub fn client_header_value(
    app: ClientApp,
    platform: ClientPlatform,
    app_version: &str,
) -> Option<String> {
    // Only horizontal whitespace is trimmed. Trimming CR/LF would silently
    // sanitize a header-injection attempt into an accepted value; those are
    // rejected by `is_serializable_app_version` instead.
    let app_version = app_version.trim_matches([' ', '\t']);
    if !is_serializable_app_version(app_version) {
        return None;
    }

    let mut value = String::with_capacity(64);
    // Field order matches the wire example and the relay's tests; RFC 8941
    // dictionaries are order-independent, so this is presentation only.
    let _ = write!(
        value,
        "v={CLIENT_HEADER_FORMAT_VERSION}, app={}, platform={}, app-version=\"{app_version}\"",
        app.as_str(),
        platform.as_str(),
    );

    // Unreachable for a validated version, but never emit an oversized header.
    if value.len() > MAX_HEADER_LEN {
        return None;
    }
    Some(value)
}

/// Build the header for the current compile target, or `None` on an unshipped
/// platform.
///
/// This is the entry point clients should use; it removes the chance of a
/// caller hardcoding the wrong platform for a build.
#[must_use]
pub fn client_header_value_for_host(app: ClientApp, app_version: &str) -> Option<String> {
    client_header_value(app, ClientPlatform::current()?, app_version)
}

/// Whether `url` is a destination this client may identify itself to.
///
/// The header names the application, platform, and version of the software a
/// user is running, so it is sent only to the relay the client is already
/// configured to talk to. A relay URL is operator-supplied and can point
/// anywhere, so `ws://`/`wss://` alone is not sufficient: a plaintext `ws://`
/// origin would leak the header to any on-path observer. Loopback is exempted
/// so local development still exercises the same code path.
///
/// # Examples
///
/// ```
/// use buzz_core::client_identity::may_identify_to;
///
/// assert!(may_identify_to("wss://buzz.example.com/"));
/// assert!(may_identify_to("ws://127.0.0.1:8080/"));
/// assert!(!may_identify_to("ws://buzz.example.com/"));
/// ```
#[must_use]
pub fn may_identify_to(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    match scheme.to_ascii_lowercase().as_str() {
        // TLS: the header is only visible to the relay itself.
        "wss" | "https" => true,
        // Cleartext is acceptable only when it cannot leave the machine.
        "ws" | "http" => is_loopback_authority(rest),
        _ => false,
    }
}

/// Whether an authority (`host[:port]`, possibly followed by a path) is
/// loopback.
fn is_loopback_authority(rest: &str) -> bool {
    // Trim the path/query/fragment, then any `userinfo@` prefix.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_userinfo, host)| host);
    let host = match authority.strip_prefix('[') {
        // IPv6 literal: `[::1]:port`.
        Some(inner) => inner.split(']').next().unwrap_or(""),
        None => authority.split(':').next().unwrap_or(""),
    };
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    // Parse as an address rather than prefix-matching "127.": a name like
    // `127.0.0.1.example.com` shares the prefix but is a remote host.
    host.parse::<std::net::IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

/// Whether `app_version` is safe to place inside an RFC 8941 quoted string.
///
/// RFC 8941 quoted strings admit only printable ASCII, and `"`/`\` would need
/// escaping. Rather than escape, reject: a Buzz version is always
/// dot-separated alphanumerics with optional `-`/`+` pre-release and build
/// metadata, so anything else means the caller passed something unexpected.
fn is_serializable_app_version(app_version: &str) -> bool {
    if app_version.is_empty() || app_version.len() > MAX_APP_VERSION_LEN {
        return false;
    }
    // Must start with a digit so a placeholder like "unknown" or "dev" is
    // refused rather than published as a version label.
    if !app_version.starts_with(|c: char| c.is_ascii_digit()) {
        return false;
    }
    app_version
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_documented_wire_format() {
        let value =
            client_header_value(ClientApp::Desktop, ClientPlatform::MacOs, "0.5.2").unwrap();
        assert_eq!(
            value,
            r#"v=1, app=buzz-desktop, platform=macos, app-version="0.5.2""#
        );
    }

    #[test]
    fn app_and_platform_tokens_are_stable() {
        // These strings are Prometheus label values and a cross-repo wire
        // contract with the mobile client; changing one is a breaking change.
        assert_eq!(ClientApp::Desktop.as_str(), "buzz-desktop");
        assert_eq!(ClientApp::Mobile.as_str(), "buzz-mobile");
        assert_eq!(ClientApp::Cli.as_str(), "buzz-cli");
        assert_eq!(ClientApp::Acp.as_str(), "buzz-acp");
        assert_eq!(ClientPlatform::MacOs.as_str(), "macos");
        assert_eq!(ClientPlatform::Windows.as_str(), "windows");
        assert_eq!(ClientPlatform::Linux.as_str(), "linux");
        assert_eq!(ClientPlatform::Ios.as_str(), "ios");
        assert_eq!(ClientPlatform::Android.as_str(), "android");
    }

    #[test]
    fn allowlists_cover_every_enum_variant() {
        // The relay allowlists are written as string slices; keep them in sync
        // with the enums so a new variant cannot be silently unparseable.
        for app in [
            ClientApp::Desktop,
            ClientApp::Mobile,
            ClientApp::Cli,
            ClientApp::Acp,
        ] {
            assert!(ClientApp::all().contains(&app.as_str()), "{app:?}");
        }
        assert_eq!(ClientApp::all().len(), 4);
        for platform in [
            ClientPlatform::MacOs,
            ClientPlatform::Windows,
            ClientPlatform::Linux,
            ClientPlatform::Ios,
            ClientPlatform::Android,
        ] {
            assert!(
                ClientPlatform::all().contains(&platform.as_str()),
                "{platform:?}"
            );
        }
        assert_eq!(ClientPlatform::all().len(), 5);
    }

    #[test]
    fn rejects_versions_that_are_not_versions() {
        for bad in ["", "   ", "unknown", "dev", "v1.2.3", "nightly"] {
            assert!(
                client_header_value(ClientApp::Cli, ClientPlatform::Linux, bad).is_none(),
                "expected {bad:?} to be refused"
            );
        }
    }

    #[test]
    fn rejects_versions_that_would_break_the_quoted_string() {
        // A quote or backslash would need RFC 8941 escaping; a newline would
        // allow header injection. All must be refused, never escaped.
        for bad in [
            "0.5\"2",
            "0.5\\2",
            "0.5.2\r\nX-Evil: 1",
            "0.5.2\n",
            "0.5.2 extra",
            "0.5.2\u{7f}",
            "0.5.2é",
        ] {
            assert!(
                client_header_value(ClientApp::Desktop, ClientPlatform::MacOs, bad).is_none(),
                "expected {bad:?} to be refused"
            );
        }
    }

    #[test]
    fn rejects_an_absurdly_long_version() {
        let long = format!("0.{}", "9".repeat(MAX_APP_VERSION_LEN));
        assert!(long.len() > MAX_APP_VERSION_LEN);
        assert!(client_header_value(ClientApp::Cli, ClientPlatform::Linux, &long).is_none());
    }

    #[test]
    fn accepts_prerelease_and_build_metadata() {
        let value = client_header_value(ClientApp::Cli, ClientPlatform::Linux, "1.2.3-rc.1+build9")
            .unwrap();
        assert!(value.ends_with(r#"app-version="1.2.3-rc.1+build9""#));
    }

    #[test]
    fn trims_surrounding_spaces_and_tabs_before_validating() {
        let value = client_header_value(ClientApp::Desktop, ClientPlatform::Windows, " \t0.5.2\t ")
            .unwrap();
        assert_eq!(
            value,
            r#"v=1, app=buzz-desktop, platform=windows, app-version="0.5.2""#
        );
    }

    #[test]
    fn identifies_only_to_tls_or_loopback_origins() {
        for allowed in [
            "wss://buzz.example.com/",
            "wss://buzz.example.com:8443/relay",
            "WSS://BUZZ.EXAMPLE.COM/",
            "https://buzz.example.com/",
            // Cleartext loopback cannot leave the machine.
            "ws://localhost:8080/",
            "ws://127.0.0.1:8080/",
            "ws://127.3.2.1/",
            "ws://[::1]:8080/",
        ] {
            assert!(may_identify_to(allowed), "expected {allowed:?} allowed");
        }
    }

    #[test]
    fn refuses_to_identify_over_cleartext_to_a_remote_host() {
        for refused in [
            // The header would be readable by any on-path observer.
            "ws://buzz.example.com/",
            "http://buzz.example.com/",
            "ws://192.168.1.5:8080/",
            "ws://10.0.0.1/",
            // `127.0.0.1.example.com` is a remote host, not loopback.
            "ws://127.0.0.1.example.com/",
            // Loopback in userinfo must not fool the host check.
            "ws://localhost@evil.example.com/",
            // Non-WebSocket and malformed destinations.
            "file:///etc/passwd",
            "buzz.example.com",
            "",
        ] {
            assert!(!may_identify_to(refused), "expected {refused:?} refused");
        }
    }

    #[test]
    fn host_helper_agrees_with_the_explicit_platform_on_shipped_targets() {
        // Tests only run on targets Buzz ships, so `current()` is `Some` here.
        let platform = ClientPlatform::current().expect("test host is a shipped platform");
        assert_eq!(
            client_header_value_for_host(ClientApp::Cli, "0.1.0"),
            client_header_value(ClientApp::Cli, platform, "0.1.0")
        );
    }

    #[test]
    fn generated_headers_stay_within_the_length_bound() {
        for app in [
            ClientApp::Desktop,
            ClientApp::Mobile,
            ClientApp::Cli,
            ClientApp::Acp,
        ] {
            for platform in [
                ClientPlatform::MacOs,
                ClientPlatform::Windows,
                ClientPlatform::Linux,
                ClientPlatform::Ios,
                ClientPlatform::Android,
            ] {
                let value = client_header_value(app, platform, "10.20.30-rc.1").unwrap();
                assert!(value.len() <= MAX_HEADER_LEN, "{value}");
            }
        }
    }
}
