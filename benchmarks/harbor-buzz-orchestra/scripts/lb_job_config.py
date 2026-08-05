#!/usr/bin/env python3
"""Emit the ``harbor run -c`` job config that gives a leaderboard row its name.

WHY A CONFIG FILE INSTEAD OF ``--agent``. ``harbor run --agent
harbor_buzz_orchestra:BuzzOrchestraAgent`` records the *import path* as the
agent config's ``name``, while the finished trial records
``BuzzOrchestraAgent.name()`` -- ``buzz-orchestra``. ``lb filter`` joins those
two strings to find the run's reasoning effort::

    efforts = {(a["name"], a["model_name"]): a["kwargs"]["reasoning_effort"]
               for a in config["agents"]}
    ...
    efforts.get((trial["agent_name"], trial_model(trial)))

(leaderboard/src/leaderboard/flows/filter.py). When they disagree the lookup
misses and the submission publishes ``reasoning_effort: "none"`` -- a wrong
label on a public row, not an error anyone catches. The CLI cannot make them
agree, because ``harbor/cli/jobs.py`` resolves
``resolved_import_path = agent_import_path if agent_name is None else None``:
you get one or the other. A job config can carry both, and
``AgentFactory.create_agent_from_config`` falls through to the import path for
any ``name`` that is not a built-in ``AgentName`` -- which ``buzz-orchestra``
is not, and cannot become, since ``AgentName`` is a closed enum with no
third-party registration.

The model name has the same shape of problem: ``-m/--model`` is read *only*
inside the ``--agent`` branch, so a config-supplied agent that omits
``model_name`` reports ``model_info: null`` and the row names no model at all.

Everything below is derived from the experiment manifest -- the same file that
decides which endpoint and which effort actually run -- so the published label
and the run cannot disagree by construction. There is no flag to set the model
or the effort by hand; ``--expect-effort`` only asserts what the manifest
already says, for an operator who wants the intent checked rather than assumed.

The emitted config also carries the adapter's runtime kwargs (binaries, relay
gateway, provisioner and endpoint configs). Those could be left to
``--agent-kwarg``, which merges into a config-supplied agent, but keeping them
here makes the config a complete record of the run: one file to read, and one
file the checks below can cover.

Standalone use, to inspect what a run would submit under::

    uv run --project benchmarks/harbor-buzz-orchestra/testbed \
        benchmarks/harbor-buzz-orchestra/scripts/lb_job_config.py \
        --manifest benchmarks/harbor-buzz-orchestra/manifests/<CELL>.yaml \
        --expect-effort max
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
AGENT_IMPORT = "harbor_buzz_orchestra:BuzzOrchestraAgent"
# BuzzOrchestraAgent.name(). Hard-coded rather than imported so this script
# runs without the adapter installed; check_agent_name() below proves the two
# still agree whenever it *is* importable.
AGENT_NAME = "buzz-orchestra"

# Job-config fields Terminal-Bench rejects outright
# (leaderboard/src/leaderboard/ci/static_analysis.py). Checked here so a
# disqualifying setting fails while it is still a file on disk, rather than
# after 445 trials have been paid for.
FORBIDDEN_JOB_FIELDS = (
    "agent_timeout_multiplier",
    "verifier_timeout_multiplier",
    "agent_setup_timeout_multiplier",
    "environment_build_timeout_multiplier",
)
FORBIDDEN_AGENT_FIELDS = (
    "override_timeout_sec",
    "override_setup_timeout_sec",
    "max_timeout_sec",
)
FORBIDDEN_VERIFIER_FIELDS = ("override_timeout_sec", "max_timeout_sec")
FORBIDDEN_ENV_FIELDS = (
    "override_cpus",
    "override_gpus",
    "override_memory_mb",
    "override_storage_mb",
)


class ConfigError(ValueError):
    """Raised when a manifest cannot produce a valid submission config."""


def _roster_entry(manifest: Any) -> Any:
    """The single seat whose model the leaderboard row will name.

    A team manifest is refused rather than guessed at: the row carries one
    ``model_name``, and picking the lead's would describe a run that two other
    models also did the work for.
    """
    roster = list(manifest.roster)
    seats = sum(entry.count for entry in roster)
    if len(roster) != 1 or seats != 1:
        raise ConfigError(
            f"{manifest.condition}: a leaderboard row names one model, but this "
            f"manifest rosters {seats} seat(s) across {len(roster)} entr(ies). "
            "Submit a solo cell, or add a deliberate model-naming rule first."
        )
    return roster[0]


def model_name(manifest: Any) -> str:
    """The model id the leaderboard row displays.

    The manifest's ``endpoint`` -- the provider-facing id, e.g.
    ``deepseek/deepseek-v4-flash-0731`` -- rather than ``model_revision``, which
    is this study's internal dated alias and would name nothing a reader could
    look up. Harbor splits it on the first ``/`` into provider + name, and the
    leaderboard rejoins them, so the round trip is exact.
    """
    return _roster_entry(manifest).endpoint


def reasoning_effort(manifest: Any) -> str:
    """The effort the row displays, taken from the manifest that sets it.

    Refuses an unset effort. Unset is legal for a study cell -- it means the
    harness constant applies -- but a public row must not label a run with an
    effort no file records.
    """
    entry = _roster_entry(manifest)
    effort = entry.generation.thinking_effort if entry.generation else None
    if effort is None:
        raise ConfigError(
            f"{manifest.condition}: roster seat '{entry.id}' does not pin "
            "generation.thinking_effort. A submission publishes the effort as a "
            "label, so it has to be stated rather than inherited."
        )
    return effort


def check_agent_name() -> None:
    """Prove AGENT_NAME still matches what a trial will actually report."""
    try:
        from harbor_buzz_orchestra.agent import BuzzOrchestraAgent
    except ImportError:
        return  # Inspecting the config outside the testbed; nothing to check.
    actual = BuzzOrchestraAgent.name()
    if actual != AGENT_NAME:
        raise ConfigError(
            f"agent name drift: this script writes '{AGENT_NAME}' into the job "
            f"config but BuzzOrchestraAgent.name() returns '{actual}'. The "
            "leaderboard joins those two, so the row would lose its effort label."
        )


def build(
    manifest: Any,
    *,
    kwargs: dict[str, Any] | None = None,
    import_path: str = AGENT_IMPORT,
) -> dict[str, Any]:
    """The job config: one agent, named twice so both readers resolve it.

    Only ``agents`` is set. Everything else about the run -- dataset, attempts,
    concurrency, job name -- stays on the ``harbor run`` command line, where
    ``harbor/cli/jobs.py`` overwrites the corresponding config field. Nothing a
    submission depends on is left to a default this file could shadow.
    """
    check_agent_name()
    agent: dict[str, Any] = {
        # Both, deliberately: `name` is what the leaderboard joins on and what
        # the trial reports; `import_path` is what actually gets constructed.
        "name": AGENT_NAME,
        "import_path": import_path,
        "model_name": model_name(manifest),
        "kwargs": {
            **{key: str(value) for key, value in (kwargs or {}).items()},
            # Read by `lb filter` off the job config, never by the agent -- it
            # lands in **kwargs on BaseAgent.__init__ and is dropped. The effort
            # that runs comes from the manifest; this is the label for it, which
            # is why both are derived from the same field.
            "reasoning_effort": reasoning_effort(manifest),
        },
    }
    return {"agents": [agent]}


def check_submittable(config: dict[str, Any]) -> list[str]:
    """Return every reason Terminal-Bench would reject a job run from this
    config. Empty means the config carries none of the disqualifying knobs --
    it does not mean the *run* stays clean, since the command line can still
    add ``--timeout-multiplier`` or an override flag.
    """
    problems: list[str] = []
    multiplier = config.get("timeout_multiplier")
    if multiplier is not None and float(multiplier) != 1.0:
        problems.append(f"timeout_multiplier is {multiplier} (must be 1.0 or unset)")
    for field in FORBIDDEN_JOB_FIELDS:
        if config.get(field) is not None:
            problems.append(f"{field} is set ({config[field]})")
    for field in FORBIDDEN_ENV_FIELDS:
        value = (config.get("environment") or {}).get(field)
        if value is not None:
            problems.append(f"environment.{field} is set ({value})")
    for field in FORBIDDEN_VERIFIER_FIELDS:
        value = (config.get("verifier") or {}).get(field)
        if value is not None:
            problems.append(f"verifier.{field} is set ({value})")
    for index, agent in enumerate(config.get("agents") or []):
        for field in FORBIDDEN_AGENT_FIELDS:
            if agent.get(field) is not None:
                problems.append(f"agents[{index}].{field} is set ({agent[field]})")
        if not agent.get("model_name"):
            problems.append(f"agents[{index}].model_name is unset (row names no model)")
        if not (agent.get("kwargs") or {}).get("reasoning_effort"):
            problems.append(
                f"agents[{index}].kwargs.reasoning_effort is unset "
                "(row publishes effort 'none')"
            )
    return problems


def write(config: dict[str, Any], path: Path) -> Path:
    """Write the config, refusing to leave a disqualifying one on disk."""
    problems = check_submittable(config)
    if problems:
        raise ConfigError(
            "refusing to write a job config the leaderboard would reject:\n  - "
            + "\n  - ".join(problems)
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--manifest", type=Path, required=True, help="Team manifest YAML")
    parser.add_argument(
        "--out", type=Path, default=None, help="Write here instead of stdout"
    )
    parser.add_argument(
        "--expect-effort",
        default=None,
        metavar="EFFORT",
        help="Fail unless the manifest pins this reasoning effort. Asserts the "
        "operator's intent against the file that decides it.",
    )
    args = parser.parse_args(argv)

    sys.path.insert(0, str(PACKAGE_ROOT / "src"))
    from harbor_buzz_orchestra.manifest import ExperimentManifest

    try:
        manifest = ExperimentManifest.load(args.manifest)
        effort = reasoning_effort(manifest)
        if args.expect_effort is not None and effort != args.expect_effort:
            raise ConfigError(
                f"{args.manifest} pins thinking_effort '{effort}', not "
                f"'{args.expect_effort}'. The manifest decides what runs; edit it "
                "rather than the label, or the row will describe a different run."
            )
        config = build(manifest)
    except ConfigError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    if args.out:
        print(write(config, args.out))
    else:
        problems = check_submittable(config)
        print(json.dumps(config, indent=2))
        for problem in problems:
            print(f"warning: {problem}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
