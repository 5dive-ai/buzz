use super::{AgentDefinition, RespondTo};

/// Empty input is allowed here — the boundary check (allowlist mode requires
/// at least one entry) is the caller's job, because an `UpdateManagedAgentRequest`
/// may want to validate a list without yet knowing the final mode.
pub fn validate_respond_to_allowlist(input: &[String]) -> Result<Vec<String>, String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(input.len());
    for entry in input {
        let trimmed = entry.trim();
        if trimmed.len() != 64 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!(
                "invalid pubkey in respond-to allowlist: '{trimmed}' (must be 64 hex chars)"
            ));
        }
        let lower = trimmed.to_ascii_lowercase();
        if seen.insert(lower.clone()) {
            out.push(lower);
        }
    }
    Ok(out)
}

/// The behavioral fields resolved for a new instance at mint time.
#[derive(Debug, PartialEq, Eq)]
pub struct MintBehavioralDefaults {
    pub respond_to: RespondTo,
    pub respond_to_allowlist: Vec<String>,
    /// Validated (1..=32) when present; caller applies its own default.
    pub parallelism: Option<u32>,
}

/// Resolve the NIP-AP behavioral quad for a new instance: explicit input
/// wins, then the linked definition's defaults, then client defaults.
///
/// This is the ONLY place definition behavioral strings are parsed — an
/// unrecognized `respond_to` mode or out-of-range `parallelism` on a
/// definition fails the mint loudly instead of silently substituting a
/// default the definition author did not choose. The empty-allowlist guard
/// fires here too, because inbound definitions bypass the dialog entirely.
///
/// `input_allowlist` must already be normalized via
/// [`validate_respond_to_allowlist`]; the definition's allowlist is
/// validated here since it arrives from the wire.
pub fn resolve_mint_behavioral_defaults(
    input_respond_to: Option<RespondTo>,
    input_allowlist: Vec<String>,
    input_parallelism: Option<u32>,
    definition: Option<&AgentDefinition>,
) -> Result<MintBehavioralDefaults, String> {
    let (respond_to, respond_to_allowlist) = match input_respond_to {
        // Explicit instance-level choice: the definition default is ignored
        // wholesale (mode AND list travel together).
        Some(mode) => (mode, input_allowlist),
        None => match definition.and_then(|d| d.respond_to.as_deref()) {
            Some(wire) => {
                let mode = RespondTo::parse_wire(wire)?;
                let list = if input_allowlist.is_empty() {
                    validate_respond_to_allowlist(
                        definition
                            .map(|d| d.respond_to_allowlist.as_slice())
                            .unwrap_or(&[]),
                    )
                    .map_err(|e| format!("definition respond-to allowlist is invalid: {e}"))?
                } else {
                    input_allowlist
                };
                (mode, list)
            }
            None => (RespondTo::default(), input_allowlist),
        },
    };
    if respond_to == RespondTo::Allowlist && respond_to_allowlist.is_empty() {
        return Err(
            "respond-to mode 'allowlist' requires at least one pubkey in the allowlist".to_string(),
        );
    }

    let parallelism = match input_parallelism {
        // Explicit input is validated here too (not just at the command
        // call sites) so the "validated when present" contract on
        // `MintBehavioralDefaults.parallelism` is unskippable.
        Some(count) if (1..=32).contains(&count) => Some(count),
        Some(count) => {
            return Err(format!(
                "parallelism {count} is out of range (must be between 1 and 32)"
            ))
        }
        None => match definition.and_then(|d| d.parallelism) {
            Some(count) if (1..=32).contains(&count) => Some(count),
            Some(count) => {
                return Err(format!(
                    "parallelism {count} on the linked agent definition is out of range (must be between 1 and 32)"
                ))
            }
            None => None,
        },
    };

    Ok(MintBehavioralDefaults {
        respond_to,
        respond_to_allowlist,
        parallelism,
    })
}
