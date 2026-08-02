# Provider wire fixtures

The shared arbiter for the stdin/stdout contract between the desktop
(`agents_deploy.rs`) and this provider (spec §Provider Protocol).

Each `*.request.json` is a request the desktop can emit; each matching
`*.response.json` is the exact response this provider produces for it. The
provider side is asserted by `tests/wire_fixtures.rs`; the desktop side should
assert that its emitted payloads parse as the corresponding request.

Two rules keep these useful rather than decorative:

* **Requests are recorded, not invented.** A fixture that no caller emits
  tests a contract nobody has.
* **Responses are byte-compared after key-sorted re-serialization**, so a
  field rename or a type change fails here rather than in a desktop that
  silently reads `undefined`.

`deploy-*` fixtures cover only responses reachable without a cluster —
refusals and malformed input. A successful deploy needs an apiserver and is
covered by the conformance suite, not by a static fixture.
