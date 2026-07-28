use std::{net::IpAddr, time::Duration};

use futures_util::StreamExt;
use reqwest::{
    header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, LOCATION, USER_AGENT},
    redirect::Policy,
};
use serde::Serialize;
use url::Url;

const MAX_PREVIEW_FETCH_BYTES: usize = 256 * 1024;
const PREVIEW_FETCH_TIMEOUT: Duration = Duration::from_secs(4);
const PREVIEW_TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 3;
const MAX_METADATA_CHARS: usize = 180;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreviewMetadata {
    title: String,
    site_name: Option<String>,
}

#[tauri::command]
pub async fn fetch_link_preview_metadata(
    href: String,
) -> Result<Option<LinkPreviewMetadata>, String> {
    tokio::time::timeout(
        PREVIEW_TOTAL_TIMEOUT,
        fetch_link_preview_metadata_inner(href),
    )
    .await
    .map_err(|_| "link preview request timed out".to_string())?
}

async fn fetch_link_preview_metadata_inner(
    href: String,
) -> Result<Option<LinkPreviewMetadata>, String> {
    let mut url = Url::parse(href.trim()).map_err(|error| format!("invalid URL: {error}"))?;
    validate_public_https_url(&url).await?;

    for redirect_count in 0..=MAX_REDIRECTS {
        let response = send_pinned_request(&url).await?;

        if response.status().is_redirection() {
            if redirect_count == MAX_REDIRECTS {
                return Ok(None);
            }
            let Some(location) = response.headers().get(LOCATION) else {
                return Ok(None);
            };
            let location = location
                .to_str()
                .map_err(|_| "link preview redirect has an invalid location".to_string())?;
            url = url
                .join(location)
                .map_err(|error| format!("invalid link preview redirect: {error}"))?;
            validate_public_https_url(&url).await?;
            continue;
        }

        if !response.status().is_success() || !is_html_response(&response) {
            return Ok(None);
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_PREVIEW_FETCH_BYTES as u64)
        {
            return Ok(None);
        }

        let body = read_limited_text(response).await?;
        return Ok(extract_link_preview_metadata(&body));
    }

    Ok(None)
}

async fn validate_public_https_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return Err("link previews require an HTTPS URL without credentials".to_string());
    }
    if url.port().is_some_and(|port| port != 443) {
        return Err("link previews require the default HTTPS port".to_string());
    }

    let host = url
        .host_str()
        .ok_or_else(|| "link preview URL has no host".to_string())?;
    resolve_public_addresses(host).await.map(|_| ())
}

async fn resolve_public_addresses(host: &str) -> Result<Vec<IpAddr>, String> {
    let host = host.to_string();
    let addresses = tokio::net::lookup_host((host.as_str(), 443))
        .await
        .map_err(|error| format!("link preview DNS resolution failed: {error}"))?
        .map(|address| address.ip())
        .collect::<Vec<_>>();

    if addresses.is_empty() {
        return Err("link preview DNS resolution returned no addresses".to_string());
    }
    if addresses.iter().any(buzz_core_pkg::network::is_private_ip) {
        return Err("link preview host resolved to a private or reserved address".to_string());
    }

    Ok(addresses)
}

async fn send_pinned_request(url: &Url) -> Result<reqwest::Response, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "link preview URL has no host".to_string())?;
    let addresses = resolve_public_addresses(host).await?;
    let socket_addresses = addresses
        .into_iter()
        .map(|address| std::net::SocketAddr::new(address, 443))
        .collect::<Vec<_>>();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .pool_max_idle_per_host(0)
        .resolve_to_addrs(host, &socket_addresses)
        .build()
        .map_err(|error| format!("link preview client failed: {error}"))?;
    let request = client
        .get(url.as_str())
        .header(ACCEPT, "text/html,application/xhtml+xml;q=0.9")
        .header(USER_AGENT, "Buzz Desktop link preview");

    tokio::time::timeout(PREVIEW_FETCH_TIMEOUT, request.send())
        .await
        .map_err(|_| "link preview request timed out".to_string())?
        .map_err(|error| format!("link preview request failed: {error}"))
}

fn is_html_response(response: &reqwest::Response) -> bool {
    response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            let mime = value.split(';').next().unwrap_or_default().trim();
            mime.eq_ignore_ascii_case("text/html")
                || mime.eq_ignore_ascii_case("application/xhtml+xml")
        })
        .unwrap_or(false)
        && response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<usize>().ok())
            .is_none_or(|size| size <= MAX_PREVIEW_FETCH_BYTES)
}

async fn read_limited_text(response: reqwest::Response) -> Result<String, String> {
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("reading link preview failed: {error}"))?;
        if bytes.len() + chunk.len() > MAX_PREVIEW_FETCH_BYTES {
            return Err("link preview response exceeded the size limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn extract_link_preview_metadata(html: &str) -> Option<LinkPreviewMetadata> {
    let title = extract_meta_content(html, "property", "og:title")
        .or_else(|| extract_meta_content(html, "name", "twitter:title"))
        .or_else(|| extract_title_tag(html))
        .and_then(|value| normalize_metadata_text(&value))?;
    let site_name = extract_meta_content(html, "property", "og:site_name")
        .and_then(|value| normalize_metadata_text(&value));

    Some(LinkPreviewMetadata { title, site_name })
}

fn extract_meta_content(html: &str, key_attr: &str, key_value: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut search_from = 0;

    while let Some(relative_start) = lower[search_from..].find("<meta") {
        let start = search_from + relative_start;
        let Some(relative_end) = lower[start..].find('>') else {
            break;
        };
        let end = start + relative_end + 1;
        let tag = &html[start..end];
        if attr_value(tag, key_attr).is_some_and(|value| value.eq_ignore_ascii_case(key_value)) {
            if let Some(content) = attr_value(tag, "content") {
                return Some(content);
            }
        }
        search_from = end;
    }

    None
}

fn extract_title_tag(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let content_start = start + lower[start..].find('>')? + 1;
    let content_end = content_start + lower[content_start..].find("</title>")?;
    Some(decode_html_entities(&html[content_start..content_end]))
}

fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let attr = attr.to_ascii_lowercase();
    let mut search_from = 0;

    while let Some(relative_start) = lower[search_from..].find(&attr) {
        let name_start = search_from + relative_start;
        let name_end = name_start + attr.len();
        let before = lower[..name_start].chars().last();
        let after = lower[name_end..].chars().next();
        let has_name_boundary = !matches!(before, Some(c) if c.is_ascii_alphanumeric() || c == '-' || c == '_')
            && !matches!(after, Some(c) if c.is_ascii_alphanumeric() || c == '-' || c == '_');

        if has_name_boundary {
            let rest = &tag[name_end..];
            let equals_offset = rest.find('=')?;
            let value = rest[equals_offset + 1..].trim_start();
            let quote = value.chars().next()?;
            if quote == '"' || quote == '\'' {
                let value_body = &value[quote.len_utf8()..];
                let value_end = value_body.find(quote)?;
                return Some(decode_html_entities(&value_body[..value_end]));
            }
            let value_end = value
                .find(|c: char| c.is_ascii_whitespace() || c == '>')
                .unwrap_or(value.len());
            return Some(decode_html_entities(&value[..value_end]));
        }
        search_from = name_end;
    }

    None
}

fn normalize_metadata_text(raw: &str) -> Option<String> {
    let mut normalized = decode_html_entities(raw)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    for suffix in [
        " - Google Docs",
        " - Google Sheets",
        " - Google Slides",
        " - Google Drive",
    ] {
        if let Some(stripped) = normalized.strip_suffix(suffix) {
            normalized = stripped.trim().to_string();
            break;
        }
    }
    if matches!(
        normalized.as_str(),
        "" | "Sign in - Google Accounts" | "Google Docs" | "Google Sheets" | "Google Slides"
    ) {
        return None;
    }
    Some(normalized.chars().take(MAX_METADATA_CHARS).collect())
}

fn decode_html_entities(value: &str) -> String {
    let mut decoded = value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">");

    while let Some(start) = decoded.find("&#") {
        let Some(relative_end) = decoded[start..].find(';') else {
            break;
        };
        let end = start + relative_end + 1;
        let entity = &decoded[start + 2..end - 1];
        let parsed = entity
            .strip_prefix('x')
            .or_else(|| entity.strip_prefix('X'))
            .and_then(|hex| u32::from_str_radix(hex, 16).ok())
            .or_else(|| entity.parse::<u32>().ok());
        let Some(ch) = parsed.and_then(char::from_u32) else {
            break;
        };
        decoded.replace_range(start..end, &ch.to_string());
    }
    decoded
}

#[cfg(test)]
mod tests {
    use super::{extract_link_preview_metadata, LinkPreviewMetadata};

    #[test]
    fn metadata_prefers_open_graph_and_reads_site_name() {
        let html = r#"<meta content="Buzz" property="og:site_name">
          <meta content="Rich previews &amp; cards" property="og:title">
          <meta name="twitter:title" content="Twitter fallback"><title>Fallback</title>"#;
        assert_eq!(
            extract_link_preview_metadata(html),
            Some(LinkPreviewMetadata {
                title: "Rich previews & cards".to_string(),
                site_name: Some("Buzz".to_string()),
            })
        );
    }

    #[test]
    fn metadata_falls_back_to_twitter_then_title() {
        assert_eq!(
            extract_link_preview_metadata("<meta content='Tweet title' name='twitter:title'>")
                .map(|metadata| metadata.title),
            Some("Tweet title".to_string())
        );
        assert_eq!(
            extract_link_preview_metadata("<title> Plain   title </title>")
                .map(|metadata| metadata.title),
            Some("Plain title".to_string())
        );
    }

    #[test]
    fn metadata_requires_a_non_empty_title() {
        assert_eq!(extract_link_preview_metadata("<title>   </title>"), None);
        assert_eq!(extract_link_preview_metadata("<html></html>"), None);
    }
}
