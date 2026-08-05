#!/usr/bin/env python3
"""Run a problem set with a team manifest and produce leaderboard-ready results.

One command wraps ``harbor run``. Every flag it accepts produces a submittable
job by default; three deliberate opt-outs do not, and each has to be asked for
by name:

* ``--timeout-multiplier`` — a study can legitimately want to know what an agent
  scores when the clock is not the constraint.
* ``--override-cpus`` / ``--override-memory-mb`` / ``--override-storage-mb`` —
  Harbor enforces a task's declared resources as hard limits, and when the agent
  harness runs *inside* the task container a multi-agent roster shares them with
  the task's own work. Refusing to raise them does not keep a comparison honest;
  it hides the distortion in the score instead of in the configuration.

Per-phase timeout knobs and ``--override-gpus`` are still never accepted:
nothing in Terminal-Bench 2.1 asks for a GPU, so that one could only add
capability rather than remove an artificial constraint.

Terminal-Bench rejects a submission carrying any of these
(``leaderboard/src/leaderboard/ci/static_analysis.py``), so a job produced with
them is a local measurement, not a leaderboard entry, and this script says so
when it runs.

``--submission`` goes one step further: it refuses those opt-outs outright, and
routes the agent through a job config so the run publishes the model and effort
it actually used. See ``lb_job_config.py`` for why the command line alone cannot
express that. Without ``--submission`` the run still uses ``--agent``, which is
what every study cell has always done and what their recorded configs show.

After the run it writes a ``metadata.yaml`` template derived from the manifest
and prints the exact upload/submit commands.

Run inside the testbed environment so ``harbor`` and the adapter are
importable:

    uv run --project benchmarks/harbor-buzz-orchestra/testbed \
        benchmarks/harbor-buzz-orchestra/scripts/run_leaderboard.py \
        --dataset terminal-bench/terminal-bench-2-1 \
        --attempts 5 \
        --manifest benchmarks/harbor-buzz-orchestra/manifests/<TEAM>.yaml \
        --endpoint-config benchmarks/harbor-buzz-orchestra/testbed/endpoints/<ENDPOINTS>.json \
        --provisioner-config <PROVISIONER.json> \
        --agent-bin-dir <DIR with Linux buzz-acp/buzz-agent/buzz-dev-mcp>
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import subprocess
import sys
from pathlib import Path

import yaml

# benchmark.py loads this file by explicit spec rather than by import, so the
# scripts directory is not necessarily on the path when a sibling is needed.
_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import lb_job_config  # noqa: E402 -- needs the path entry above

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
AGENT_IMPORT = "harbor_buzz_orchestra:BuzzOrchestraAgent"
PROVISIONER_FACTORY = "harbor_buzz_testbed:provisioner_from_dict"
# Host-side: the harness speaks to the relay as the trial user via this CLI.
BINARIES = ("buzz",)
# Container-side: the production stack uploaded into each task container.
# These must be Linux builds matching the task image architecture.
AGENT_BINARIES = ("buzz-acp", "buzz-agent", "buzz-dev-mcp")
# Uploaded alongside the stack when --relay-gateway is set: bridges the
# agents' canonical relay address to the host gateway (the relay is
# host-header tenant-bound, so agents must present its canonical Host).
FORWARDER_BINARY = "relay-forwarder"

PROVIDER_ORGS = {"anthropic": "Anthropic", "openai": "OpenAI", "databricks": "Databricks"}

# leaderboard/src/leaderboard/ci/static_analysis.py: MIN_TRIALS_PER_TASK.
LEADERBOARD_MIN_ATTEMPTS = 5
LEADERBOARD_REPO = "harbor-framework/terminal-bench-2-1"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0], formatter_class=argparse.RawDescriptionHelpFormatter
    )
    problems = parser.add_mutually_exclusive_group(required=True)
    problems.add_argument(
        "--dataset", "-d", help="Registry dataset (e.g. terminal-bench/terminal-bench-2-1)"
    )
    problems.add_argument(
        "--path", "-p", type=Path, help="Local task or dataset directory"
    )
    parser.add_argument(
        "--include-task", "-i", action="append", default=[],
        help="Task name to include from the dataset (glob, repeatable)",
    )
    parser.add_argument(
        "--exclude-task", "-x", action="append", default=[],
        help="Task name to exclude from the dataset (glob, repeatable)",
    )
    parser.add_argument(
        "--attempts", "-k", type=int, required=True,
        help="Runs per problem (leaderboards require 5)",
    )
    parser.add_argument("--manifest", type=Path, required=True, help="Team manifest YAML")
    parser.add_argument(
        "--endpoint-config", type=Path, required=True,
        help="JSON mapping manifest endpoint names to providers/API keys",
    )
    parser.add_argument(
        "--provisioner-config", type=Path, required=True,
        help="JSON config for the Buzz relay/Postgres provisioner",
    )
    parser.add_argument(
        "--buzz-bin-dir", type=Path, default=None,
        help="Directory with the host buzz CLI (default: repo target/release, then target/debug)",
    )
    parser.add_argument(
        "--agent-bin-dir", type=Path, required=True,
        help="Directory with Linux builds of buzz-acp/buzz-agent/buzz-dev-mcp "
        "to upload into each task container",
    )
    parser.add_argument(
        "--relay-gateway", default="",
        help="host:port of the benchmark relay as reachable from inside the "
        "task container (e.g. host.docker.internal:3600). When set, a "
        "loopback forwarder from --agent-bin-dir bridges the canonical "
        "relay address to this gateway",
    )
    parser.add_argument("--n-concurrent", "-n", type=int, default=4, help="Concurrent trials")
    parser.add_argument(
        "--timeout-multiplier", type=float, default=None, metavar="N",
        help="Scale every Harbor phase timeout (agent, verifier, setup, build) "
             "by N. Anything but 1.0 makes the job unsubmittable to the "
             "leaderboard; omit it for a submittable run.",
    )
    # Resource overrides: off unless asked for, and unsubmittable when used.
    # They exist because the Buzz stack runs *inside* the task container, so a
    # multi-agent roster shares one task's declared 1 vCPU and 2 GB with three
    # process groups. Refusing them does not keep a study honest; it just moves
    # the distortion somewhere it cannot be seen.
    parser.add_argument(
        "--override-cpus", type=int, default=None, metavar="N",
        help="Give every task N CPUs instead of its own declared request. "
             "Makes the job unsubmittable; omit for a submittable run.",
    )
    parser.add_argument(
        "--override-memory-mb", type=int, default=None, metavar="MB",
        help="Give every task MB of memory instead of its own declared "
             "request. Makes the job unsubmittable; omit for a submittable run.",
    )
    parser.add_argument(
        "--override-storage-mb", type=int, default=None, metavar="MB",
        help="Give every task MB of storage instead of its own declared "
             "request. Makes the job unsubmittable; omit for a submittable run.",
    )
    parser.add_argument("--jobs-dir", type=Path, default=Path("jobs"), help="Job output root")
    parser.add_argument("--job-name", default=None, help="Job name (default: lb-<condition>-<UTC>)")
    parser.add_argument(
        "--submission", action="store_true",
        help="Produce a job that can be submitted to the public Terminal-Bench "
             "leaderboard: refuse every override flag, and name the agent, model "
             "and reasoning effort through a job config so the published row "
             "matches the run. Requires a solo manifest that pins its effort.",
    )
    parser.add_argument(
        "--upload", action="store_true", help="Upload to Harbor Hub when the job finishes"
    )
    parser.add_argument(
        "--public", action="store_true",
        help="Make the uploaded job public (requires --upload). A leaderboard "
             "submission has to be public — CI reads the job through the hub.",
    )
    parser.add_argument(
        "--share-org", action="append", default=[], metavar="ORG",
        help="Share the uploaded job with a Harbor Hub organization "
             "(requires --upload, repeatable). An upload is owned by the "
             "authenticated user; sharing is how it also appears under an org.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Print the harbor command and exit")
    return parser.parse_args(argv)


def find_binaries(bin_dir: Path | None) -> dict[str, Path]:
    candidates = (
        [bin_dir]
        if bin_dir is not None
        else [PACKAGE_ROOT.parents[1] / "target" / kind for kind in ("release", "debug")]
    )
    for candidate in candidates:
        found = {name: candidate / name for name in BINARIES}
        if all(path.is_file() for path in found.values()):
            return found
    searched = ", ".join(str(c) for c in candidates)
    raise SystemExit(
        f"buzz binaries not found (need {', '.join(BINARIES)}; searched {searched}). "
        "Build them with `cargo build` or pass --buzz-bin-dir."
    )


def find_agent_binaries(bin_dir: Path, with_forwarder: bool = False) -> dict[str, Path]:
    """The Linux agent stack uploaded into each task container."""
    names = AGENT_BINARIES + ((FORWARDER_BINARY,) if with_forwarder else ())
    found = {name: bin_dir / name for name in names}
    missing = [name for name, path in found.items() if not path.is_file()]
    if missing:
        raise SystemExit(
            f"Linux agent binaries not found in {bin_dir}: {', '.join(missing)}. "
            "`just benchmark` builds them; or cross-compile with "
            "cargo --target <arch>-unknown-linux-musl and pass --agent-bin-dir."
        )
    return found


def agent_kwargs(
    args: argparse.Namespace,
    binaries: dict[str, Path],
    agent_binaries: dict[str, Path],
) -> dict[str, object]:
    """Everything BuzzOrchestraAgent needs to construct itself.

    Shared by both paths: ``--agent-kwarg`` on a study run, the job config's
    ``kwargs`` on a submission run. One definition, so the two cannot drift into
    running different things.
    """
    kwargs: dict[str, object] = {
        "manifest": args.manifest,
        "provisioner_factory": PROVISIONER_FACTORY,
        "provisioner_config": args.provisioner_config,
        "artifact_root": PACKAGE_ROOT,
        "endpoint_config": args.endpoint_config,
        "buzz_acp_binary": agent_binaries["buzz-acp"],
        "buzz_agent_binary": agent_binaries["buzz-agent"],
        "buzz_dev_mcp_binary": agent_binaries["buzz-dev-mcp"],
        "buzz_cli_binary": binaries["buzz"],
        "run_id": args.job_name,
    }
    if args.relay_gateway:
        kwargs["relay_gateway"] = args.relay_gateway
        kwargs["forwarder_binary"] = agent_binaries[FORWARDER_BINARY]
    return kwargs


def write_job_config(
    args: argparse.Namespace,
    binaries: dict[str, Path],
    agent_binaries: dict[str, Path],
) -> Path:
    """Emit the submission job config beside the job directory.

    Raises ``lb_job_config.ConfigError`` when the manifest cannot name a single
    model at a stated effort, or when the config would carry a disqualifying
    field. Both are cheaper to hit here than after the run.
    """
    from harbor_buzz_orchestra.manifest import ExperimentManifest

    config = lb_job_config.build(
        ExperimentManifest.load(args.manifest),
        kwargs=agent_kwargs(args, binaries, agent_binaries),
        import_path=AGENT_IMPORT,
    )
    return lb_job_config.write(
        config, args.jobs_dir / f"{args.job_name}.jobconfig.json"
    )


def build_command(
    args: argparse.Namespace,
    binaries: dict[str, Path],
    agent_binaries: dict[str, Path],
    job_config: Path | None = None,
) -> list[str]:
    """Compose the harbor invocation.

    Standard settings, plus the unsubmittable knobs when they are explicitly
    asked for: ``--timeout-multiplier`` and the cpu/memory/storage overrides.
    None of them is on by default, so the command this builds is
    leaderboard-legal unless a caller opted out.

    ``--override-gpus`` is still never accepted. Nothing in Terminal-Bench 2.1
    requests a GPU, so a flag for it could only ever change what the machine can
    do rather than remove an artificial constraint.

    With ``job_config`` the agent comes from that file instead of ``--agent`` +
    ``--agent-kwarg``. The two are mutually exclusive by Harbor's own rule:
    passing ``--agent`` clears ``config.agents`` outright
    (``harbor/cli/jobs.py``), which would discard the identity the config exists
    to carry.
    """
    command = [
        "harbor", "run", "--yes",
        "--job-name", args.job_name,
        "--jobs-dir", str(args.jobs_dir),
        "-k", str(args.attempts),
        "--n-concurrent", str(args.n_concurrent),
    ]
    if job_config is not None:
        command += ["-c", str(job_config)]
    if args.timeout_multiplier is not None:
        command += ["--timeout-multiplier", str(args.timeout_multiplier)]
    for flag, value in (
        ("--override-cpus", args.override_cpus),
        ("--override-memory-mb", args.override_memory_mb),
        ("--override-storage-mb", args.override_storage_mb),
    ):
        if value is not None:
            command += [flag, str(value)]
    if args.dataset:
        command += ["--dataset", args.dataset]
    else:
        command += ["--path", str(args.path)]
    for pattern in args.include_task:
        command += ["--include-task-name", pattern]
    for pattern in args.exclude_task:
        command += ["--exclude-task-name", pattern]
    if args.upload:
        command.append("--upload")
        if args.public:
            command.append("--public")
        for org in args.share_org:
            command += ["--share-org", org]
    if job_config is None:
        command += ["--agent", AGENT_IMPORT]
        for key, value in agent_kwargs(args, binaries, agent_binaries).items():
            command += ["--agent-kwarg", f"{key}={value}"]
    return command


def write_metadata_template(args: argparse.Namespace, job_dir: Path) -> Path:
    """Derive a metadata.yaml template (harbor.leaderboard.metadata schema)
    from the manifest roster; display-name placeholders are for the submitter
    to confirm."""
    manifest = yaml.safe_load(args.manifest.read_text())
    endpoints = json.loads(args.endpoint_config.read_text())
    models, seen = [], set()
    for entry in manifest.get("roster", []):
        model = entry.get("model_revision") or entry["endpoint"]
        if model in seen:
            continue
        seen.add(model)
        provider = endpoints.get(entry["endpoint"], {}).get("provider", "FILL_ME")
        models.append(
            {
                "model_name": model,
                "model_provider": provider,
                "model_display_name": model,
                "model_org_display_name": PROVIDER_ORGS.get(provider, "FILL_ME"),
            }
        )
    metadata = {
        "agent_url": "https://github.com/block/buzz",
        "agent_display_name": f"Buzz Orchestra ({manifest.get('condition', 'team')})",
        "agent_org_display_name": "Block",
        "models": models,
    }
    path = job_dir / "metadata.yaml"
    path.write_text(yaml.safe_dump(metadata, sort_keys=False))
    return path


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    for label, path in (
        ("manifest", args.manifest),
        ("endpoint config", args.endpoint_config),
        ("provisioner config", args.provisioner_config),
    ):
        if not path.is_file():
            raise SystemExit(f"{label} not found: {path}")
    if (args.public or args.share_org) and not args.upload:
        raise SystemExit("--public / --share-org requires --upload")
    if args.submission:
        # Refused rather than warned about: --submission states an intent that
        # any of these silently defeats, and the cost of finding out is a
        # finished 445-trial run that CI rejects.
        opted_out = [
            f"--{name.replace('_', '-')} {getattr(args, name)}"
            for name in (
                "timeout_multiplier",
                "override_cpus",
                "override_memory_mb",
                "override_storage_mb",
            )
            if getattr(args, name) is not None
        ]
        if opted_out:
            raise SystemExit(
                "--submission cannot be combined with "
                f"{', '.join(opted_out)}: Terminal-Bench rejects a job carrying "
                "any of them. Drop the flag for a submittable run, or drop "
                "--submission and report the score with the settings stated."
            )
        if args.attempts < LEADERBOARD_MIN_ATTEMPTS:
            print(
                f"note: --attempts {args.attempts} is below the leaderboard's "
                f"minimum of {LEADERBOARD_MIN_ATTEMPTS} per task. The job will be "
                "shaped correctly but too small to submit — fine for a smoke "
                "test, not for the real run."
            )
    if args.job_name is None:
        condition = yaml.safe_load(args.manifest.read_text()).get("condition", "team")
        stamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%SZ")
        args.job_name = f"lb-{condition}-{stamp}"

    if args.dry_run:
        # Dry runs print the command without requiring built binaries.
        bin_dir = args.buzz_bin_dir or PACKAGE_ROOT.parents[1] / "target" / "release"
        binaries = {name: bin_dir / name for name in BINARIES}
        agent_binaries = {
            name: args.agent_bin_dir / name
            for name in AGENT_BINARIES + (FORWARDER_BINARY,)
        }
        job_config = None
        if args.submission:
            # Written even on a dry run: it is the artifact worth reviewing
            # before committing the machine time, and writing it is the check.
            try:
                job_config = write_job_config(args, binaries, agent_binaries)
            except lb_job_config.ConfigError as error:
                raise SystemExit(f"error: {error}") from error
            print(f"# job config: {job_config}")
        print(" ".join(build_command(args, binaries, agent_binaries, job_config)))
        return 0
    binaries = find_binaries(args.buzz_bin_dir)
    agent_binaries = find_agent_binaries(
        args.agent_bin_dir, with_forwarder=bool(args.relay_gateway)
    )
    job_config = None
    if args.submission:
        try:
            job_config = write_job_config(args, binaries, agent_binaries)
        except lb_job_config.ConfigError as error:
            raise SystemExit(f"error: {error}") from error
        print(f"submission job config: {job_config}")
    command = build_command(args, binaries, agent_binaries, job_config)
    if shutil.which("harbor") is None:
        raise SystemExit(
            "harbor not on PATH — run via: uv run --project "
            f"{PACKAGE_ROOT / 'testbed'} {Path(__file__).resolve()} ..."
        )

    result = subprocess.run(command)
    job_dir = args.jobs_dir / args.job_name
    if result.returncode != 0:
        print(f"harbor run failed (exit {result.returncode}); job dir: {job_dir}")
        return result.returncode

    # The submission flow builds its own metadata (`lb metadata` fills the
    # display fields from display-names.json), so the template is only useful to
    # a study run keeping a record of what it ran.
    metadata_path = None if args.submission else write_metadata_template(args, job_dir)
    overrides = [
        f"{name}={value}"
        for name, value in (
            ("timeout_multiplier", args.timeout_multiplier),
            ("override_cpus", args.override_cpus),
            ("override_memory_mb", args.override_memory_mb),
            ("override_storage_mb", args.override_storage_mb),
        )
        if value is not None
    ]
    if overrides:
        # Said once, at the end, where the submit instructions would otherwise
        # be: printing them for a job Harbor will refuse wastes someone's
        # afternoon finding out why. Naming every override matters as much as
        # naming one — a score reported without them is not comparable to a
        # leaderboard number, and the reader cannot tell from the score alone.
        print(
            f"\nJob complete: {job_dir}\n"
            f"  Ran with {', '.join(overrides)}, so Harbor's "
            "static validation will reject this job as a leaderboard submission "
            "(no_job_overrides). It is a local measurement — report the score "
            "with those settings stated alongside it."
        )
        return 0
    print(f"\nLeaderboard-shaped job complete: {job_dir}")
    if not args.submission:
        # A study run has the right *settings* but not the right agent identity:
        # --agent records the import path where the leaderboard expects
        # 'buzz-orchestra', and reports no model at all. See lb_job_config.py.
        print(
            f"  Review submitter details in {metadata_path}.\n"
            "  Re-run with --submission to submit: this job names the agent by "
            "import path and reports no model, so a submission built from it "
            "would publish a row with no model and reasoning effort 'none'."
        )
        return 0
    if args.attempts < LEADERBOARD_MIN_ATTEMPTS:
        print(
            f"  Correctly shaped, but {args.attempts} attempt(s) per task is "
            f"below the required {LEADERBOARD_MIN_ATTEMPTS}. Check "
            "<trial>/agent/trajectory.json exists on every trial, then run the "
            "full set."
        )
        return 0
    print(
        "  Submit from a clone of the leaderboard repo "
        f"({LEADERBOARD_REPO}; you need a fork, since submissions arrive as "
        "PRs):\n"
        "    uv run lb submit <job link printed by --upload>\n"
        "  That runs `lb filter` -> `lb metadata` -> `lb open-prs`. Fill the "
        "null entries `lb filter` scaffolds into display-names.json for "
        "buzz-orchestra and the model, or it will prompt for them."
    )
    if not (args.upload and args.public):
        print(
            "  This job was not uploaded public, and CI reads the job through "
            f"the hub: `harbor upload --public {job_dir}` first."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
