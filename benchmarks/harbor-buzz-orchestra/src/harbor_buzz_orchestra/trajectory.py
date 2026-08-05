"""Write the trial's ATIF trajectory, assembled from artifacts we already keep.

Harbor's uploader publishes ``<trial>/agent/trajectory.json`` as the trial's
``trajectory_path``, and the Terminal-Bench leaderboard requires one on every
*rewarded* trial: its ``/judge`` step audits successful trajectories for reward
hacking, and a pass it cannot read is a pass it cannot clear. Without this file
`Rewarded trials have trajectories` fails for every solve and the submission is
invalid, whatever the score says.

WHAT THIS READS, AND WHY IT IS A SCRAPE RATHER THAN A FEED. The Buzz stack keeps
no session file. Three artifacts between them hold the run, and this module is
the seam that joins them:

  * ``<agent_id>.stdout.log`` -- ``buzz-acp``'s tracing output. Every tool call
    the provider asked for is logged at target ``acp::tool`` as a
    ``tool_call:``/``tool_call_detail:`` pair, the second carrying the tool's
    ``rawInput`` JSON: the shell command, or the path and contents of a file
    edit. This is the substance of a reward-hacking audit.
  * ``transcript.json`` -- the channel conversation, which is what each agent
    actually *said*, including the harness's opening instruction.
  * ``receipts.jsonl``, via the ``TrialAccounting`` we already computed -- the
    token and dollar totals.

TWO LIMITS, BOTH STATED IN THE DOCUMENT'S OWN ``notes`` RATHER THAN LEFT FOR A
READER TO INFER:

  1. Tool outputs are not recorded anywhere, so ATIF ``observation`` is always
     absent. The judge sees what each command asked for but not what came back.
  2. ``tool_call_detail`` truncates ``rawInput`` at 400 bytes
     (``MAX_RAW_INPUT`` in ``buzz-acp``'s ``acp.rs``), which is a readability
     cap on a human-facing log. A long shell command is exactly what it cuts, so
     those calls arrive here as unparseable JSON and are kept as
     ``{"_raw": "<first 400 bytes>"}``. Measured across a full 89-trial
     Terminal-Bench job: 583 of 1550 calls, 38%. ``notes`` carries the per-trial
     count so nobody mistakes a prefix for a command.

Both close the same way -- emit a structured session log from ``buzz-acp``
(``acp.rs``, where the ``acp::tool`` lines are already produced) instead of
parsing its human-readable one. Worth doing; not required for a valid
submission, which gates on a trajectory being present, not on its depth.

BEST EFFORT, BUT LOUD. A trial whose trajectory cannot be written is a trial the
leaderboard will reject, so ``write`` returns the path it wrote and ``None`` when
it could not, and never raises: losing the trajectory must not turn a completed
trial into a failed one. The caller logs the ``None``.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover -- import cycle at runtime, types only
    from .accounting import TrialAccounting
    from .manifest import ExperimentManifest

logger = logging.getLogger(__name__)

SCHEMA_VERSION = "ATIF-v1.7"
AGENT_NAME = "buzz-orchestra"
AGENT_VERSION = "0.1.0"

# `tracing` colourises its output even when redirected, so every line arrives
# wrapped in SGR escapes. Strip them before matching anything.
_ANSI = re.compile(r"\x1b\[[0-9;]*m")

# 2026-07-29T21:40:54.050009Z  INFO acp::tool: tool_call: buzz-dev-mcp__shell (other)
_TOOL_LINE = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+INFO\s+acp::tool:\s+"
    r"(?P<event>tool_call|tool_call_detail|tool_call_update):\s*(?P<rest>.*)$"
)
# `buzz-dev-mcp__shell (other)` -- the trailing parenthesised word is ACP's tool
# *kind*, not part of the name.
_TOOL_TITLE = re.compile(r"^(?P<name>.*?)\s*\((?P<kind>[^()]*)\)\s*$")
# `call_WPn3YK0x8PaZtkYEC2LXzDBo -> completed` (the arrow is U+2192 in the log)
_TOOL_UPDATE = re.compile(r"^(?P<call_id>\S+)\s*(?:→|->)\s*(?P<status>\S+)\s*$")


@dataclass
class _ToolCall:
    """One tool invocation recovered from a seat's log."""

    seat: str
    epoch: float
    timestamp: str
    function_name: str
    kind: str
    arguments: dict[str, Any] = field(default_factory=dict)
    # Present only when the log's own ordering let us pair the call with an id;
    # see _pair_call_ids. Otherwise the writer synthesises one.
    call_id: str | None = None
    status: str | None = None
    # Set when `rawInput` was absent or unparseable and we kept the raw line.
    raw_detail: str | None = None


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, UTC).isoformat().replace("+00:00", "Z")


def _epoch(iso: str) -> float | None:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def parse_tool_calls(log_path: Path, seat: str) -> list[_ToolCall]:
    """Recover one seat's tool calls from its ``buzz-acp`` stdout log.

    The three ``acp::tool`` events arrive as a stream, not as records: a
    ``tool_call`` names the tool, an optional ``tool_call_detail`` immediately
    after it carries the arguments, and ``tool_call_update`` lines report status
    transitions -- carrying the provider's call id, which the first two do not.
    So a detail is attached to the most recent call, and ids are paired
    positionally afterwards (see _pair_call_ids), which is why that pairing is
    conditional rather than assumed.
    """
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []

    calls: list[_ToolCall] = []
    # call_id -> last status seen, in first-appearance order.
    statuses: dict[str, str] = {}
    for line in text.splitlines():
        match = _TOOL_LINE.match(_ANSI.sub("", line))
        if match is None:
            continue
        event, rest = match["event"], match["rest"].strip()
        epoch = _epoch(match["ts"])
        if epoch is None:
            continue

        if event == "tool_call":
            title = _TOOL_TITLE.match(rest)
            name = (title["name"] if title else rest).strip() or "unknown"
            calls.append(
                _ToolCall(
                    seat=seat,
                    epoch=epoch,
                    timestamp=_iso(epoch),
                    function_name=name,
                    kind=(title["kind"].strip() if title else ""),
                )
            )
        elif event == "tool_call_detail":
            if not calls:
                continue
            arguments, raw = _parse_detail(rest)
            calls[-1].arguments = arguments
            calls[-1].raw_detail = raw
        else:  # tool_call_update
            update = _TOOL_UPDATE.match(rest)
            if update is not None:
                statuses[update["call_id"]] = update["status"]

    _pair_call_ids(calls, statuses)
    return calls


def _parse_detail(rest: str) -> tuple[dict[str, Any], str | None]:
    """``rawInput={...}`` -> the parsed arguments; anything else -> a raw note.

    ``tool_call_detail`` also carries a ``locations=`` summary for tools that
    declare the files they touch, and that form is not JSON. Keeping the line
    verbatim under ``_raw`` beats dropping it: for a file edit it still names the
    path, which is exactly what an auditor is looking for.
    """
    if rest.startswith("rawInput="):
        payload = rest[len("rawInput=") :]
        try:
            parsed = json.loads(payload)
        except ValueError:
            return {"_raw": payload}, payload
        if isinstance(parsed, dict):
            return parsed, None
        # A non-object rawInput is legal JSON but not an ATIF arguments object.
        return {"_value": parsed}, None
    return {"_raw": rest}, rest


def _pair_call_ids(calls: list[_ToolCall], statuses: dict[str, str]) -> None:
    """Attach the provider's real call ids when the log's ordering proves them.

    ``buzz-acp`` emits its ``tool_call`` lines in the order the provider
    returned the calls and its first ``tool_call_update`` per id in that same
    order, so position identifies them -- but only if nothing was dropped. A log
    truncated mid-turn, or a call that never reached ``in_progress``, breaks the
    correspondence, and a *wrong* id is worse than no id: it would attribute a
    command to a different call. So the pairing applies only on an exact count
    match, and the writer synthesises ids otherwise.
    """
    if len(statuses) != len(calls):
        return
    for call, (call_id, status) in zip(calls, statuses.items(), strict=True):
        call.call_id = call_id
        call.status = status


def _load_transcript(path: Path) -> tuple[list[dict[str, Any]], bool]:
    """``(messages, truncated)`` from the saved channel transcript.

    ``truncated`` is the relay's own cap flag: it means the earliest messages are
    missing, which a reader of the trajectory has to be told rather than left to
    deduce from a conversation that starts mid-sentence.
    """
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return [], False
    if not isinstance(payload, dict):
        return [], False
    messages = [m for m in payload.get("messages") or [] if isinstance(m, dict)]
    return messages, bool(payload.get("truncated"))


def _seat_models(manifest: ExperimentManifest) -> dict[str, tuple[str, str | None]]:
    """``agent_id -> (model_revision, thinking_effort)`` for every seat.

    Seat ids are ``<class id>-<n>`` (``solo-1``, ``worker-2``), which is how they
    appear as transcript authors and as log filenames, so the map is built per
    instance rather than per class.
    """
    out: dict[str, tuple[str, str | None]] = {}
    for entry in manifest.roster:
        for index in range(1, entry.count + 1):
            out[f"{entry.id}-{index}"] = (
                entry.model_revision,
                entry.generation.thinking_effort,
            )
    return out


def build(
    *,
    trial_dir: Path,
    manifest: ExperimentManifest,
    instruction: str,
    session_id: str,
    accounting: TrialAccounting | None = None,
) -> dict[str, Any]:
    """Assemble the ATIF document. Pure: reads ``trial_dir``, writes nothing.

    Steps are the merged timeline of what was said (transcript) and what was
    done (tool calls). A seat's tool calls are attached to the next message that
    seat posts, because that is the turn they belong to -- an agent works and
    then reports. Calls with no message after them still get a step of their own,
    whether the seat was cut off by the trial deadline or simply acted once more
    after its last post: they happened, and a trajectory that dropped them would
    understate the run to the one reader who most needs it complete.
    """
    seats = _seat_models(manifest)
    messages, truncated = _load_transcript(trial_dir / "transcript.json")

    # rank 0 sorts tool calls ahead of a message sharing their timestamp: the
    # transcript's `created_at` has one-second resolution while the logs have
    # microseconds, so a call made during a turn routinely ties with the message
    # that ends it.
    timeline: list[tuple[float, int, str, Any]] = []
    for seat in sorted(seats):
        for call in parse_tool_calls(trial_dir / f"{seat}.stdout.log", seat):
            timeline.append((call.epoch, 0, "tool", call))
    for message in messages:
        try:
            epoch = float(message.get("created_at") or 0)
        except (TypeError, ValueError):
            continue
        timeline.append((epoch, 1, "message", message))
    timeline.sort(key=lambda item: (item[0], item[1]))

    steps: list[dict[str, Any]] = []
    pending: dict[str, list[_ToolCall]] = {}
    synthetic = 0

    def _tool_payload(calls: list[_ToolCall]) -> list[dict[str, Any]]:
        nonlocal synthetic
        payload = []
        for call in calls:
            if call.call_id is None:
                synthetic += 1
                call_id = f"{call.seat}-{synthetic}"
            else:
                call_id = call.call_id
            entry: dict[str, Any] = {
                "tool_call_id": call_id,
                "function_name": call.function_name,
                "arguments": call.arguments,
            }
            extra = {
                k: v
                for k, v in (("kind", call.kind), ("status", call.status))
                if v
            }
            if extra:
                entry["extra"] = extra
            payload.append(entry)
        return payload

    # The instruction, when the transcript did not survive to carry it. Harbor
    # hands it to us verbatim, so this is the one step that never depends on a
    # scrape.
    if not messages:
        steps.append(
            {
                "step_id": 1,
                "timestamp": None,
                "source": "user",
                "message": instruction,
            }
        )

    for _epoch_value, _rank, kind, item in timeline:
        if kind == "tool":
            pending.setdefault(item.seat, []).append(item)
            continue
        author = str(item.get("author") or "unknown")
        content = str(item.get("content") or "")
        stamp = _iso(float(item.get("created_at") or 0))
        if author in seats:
            model, effort = seats[author]
            step: dict[str, Any] = {
                "step_id": len(steps) + 1,
                "timestamp": stamp,
                "source": "agent",
                "model_name": model,
                "message": content,
            }
            if effort:
                step["reasoning_effort"] = effort
            calls = pending.pop(author, [])
            if calls:
                step["tool_calls"] = _tool_payload(calls)
            steps.append(step)
        else:
            # The harness user (and anything else that is not a roster seat).
            # ATIF forbids model_name/tool_calls/metrics on a non-agent step.
            steps.append(
                {
                    "step_id": len(steps) + 1,
                    "timestamp": stamp,
                    "source": "user",
                    "message": content,
                }
            )

    for seat in sorted(pending):
        calls = pending[seat]
        model, effort = seats[seat]
        step = {
            "step_id": len(steps) + 1,
            "timestamp": calls[-1].timestamp,
            "source": "agent",
            "model_name": model,
            "message": (
                "(no channel message reported these calls: the seat was still "
                "working when the trial ended, or acted after its last post)"
            ),
            "tool_calls": _tool_payload(calls),
        }
        if effort:
            step["reasoning_effort"] = effort
        steps.append(step)

    if not steps:  # ATIF requires at least one step.
        steps.append(
            {
                "step_id": 1,
                "timestamp": None,
                "source": "user",
                "message": instruction,
            }
        )

    # The primary model is the one that did the talking, so a team's row is
    # labelled by its lead rather than by whichever seat sorts first.
    turns_by_seat: dict[str, int] = {}
    for step in steps:
        if step["source"] == "agent":
            turns_by_seat[step["model_name"]] = turns_by_seat.get(step["model_name"], 0) + 1
    primary = (
        max(turns_by_seat.items(), key=lambda kv: kv[1])[0]
        if turns_by_seat
        else manifest.roster[0].model_revision
    )

    document: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "session_id": session_id,
        "agent": {
            "name": AGENT_NAME,
            "version": AGENT_VERSION,
            "model_name": primary,
            "extra": {
                "condition": manifest.condition,
                "manifest_sha256": manifest.sha256,
                "roster": [
                    {
                        "id": entry.id,
                        "role": entry.role,
                        "count": entry.count,
                        "model_revision": entry.model_revision,
                        "thinking_effort": entry.generation.thinking_effort,
                    }
                    for entry in manifest.roster
                ],
            },
        },
        "steps": steps,
        "notes": _notes(
            truncated=truncated,
            had_transcript=bool(messages),
            total_calls=sum(len(step.get("tool_calls") or []) for step in steps),
            clipped_calls=sum(
                1
                for step in steps
                for call in (step.get("tool_calls") or [])
                if "_raw" in (call.get("arguments") or {})
            ),
        ),
    }
    if accounting is not None:
        document["final_metrics"] = {
            "total_prompt_tokens": accounting.input_tokens,
            "total_completion_tokens": accounting.output_tokens,
            "total_cached_tokens": accounting.estimated_cache_read_tokens,
            "total_cost_usd": round(accounting.cost_usd, 6),
            "total_steps": len(steps),
        }
    return document


def _notes(
    *,
    truncated: bool,
    had_transcript: bool,
    total_calls: int = 0,
    clipped_calls: int = 0,
) -> str:
    """The document's own account of what it is and is not.

    A trajectory assembled from logs can mislead by omission, so the omissions
    travel with it, counted rather than described. The judge reads this.
    """
    parts = [
        "Assembled by harbor_buzz_orchestra.trajectory from the trial's own "
        "artifacts: agent messages from the Buzz channel transcript, tool calls "
        "from buzz-acp's acp::tool trace, token and cost totals from the "
        "per-seat receipts.",
        "TOOL RESULTS ARE NOT AVAILABLE: buzz-acp logs what each tool was asked "
        "to do but not what it returned, so every step's `observation` is "
        "absent. What a command did has to be inferred from the next message.",
        "Per-step `metrics` are absent for the same reason -- usage is reported "
        "per seat per provider round, not per channel message -- so the totals "
        "live in `final_metrics` only.",
    ]
    if clipped_calls:
        # Not a rounding detail: buzz-acp's MAX_RAW_INPUT caps the logged
        # rawInput at 400 bytes (acp.rs), and a long shell command is exactly
        # what gets cut. An auditor reading `_raw` must know it is a prefix and
        # how much of this trial's evidence is in that shape.
        parts.append(
            f"{clipped_calls} of {total_calls} tool calls have an `arguments` "
            "object of the form {\"_raw\": \"...\"}: buzz-acp truncates the "
            "logged rawInput at 400 bytes, so those are the first 400 bytes of "
            "the request and not the whole of it. The remaining "
            f"{total_calls - clipped_calls} are complete, parsed objects."
        )
    if not had_transcript:
        parts.append(
            "The channel transcript was not recovered for this trial, so the "
            "steps below carry the task instruction and any tool calls found in "
            "the seat logs, without the agents' messages."
        )
    if truncated:
        parts.append(
            "The relay's message query hit its cap, so the earliest channel "
            "messages are missing from this trajectory."
        )
    return " ".join(parts)


def write(
    *,
    logs_dir: Path,
    trial_dir: Path,
    manifest: ExperimentManifest,
    instruction: str,
    session_id: str,
    accounting: TrialAccounting | None = None,
) -> Path | None:
    """Build, validate and write ``<logs_dir>/trajectory.json``.

    ``logs_dir`` is Harbor's agent log directory -- ``<trial>/agent`` -- because
    that exact path is what the uploader looks for. ``trial_dir`` is the
    ``buzz/`` subdirectory the stack's own artifacts land in.

    Validation runs through Harbor's own pydantic model when it is importable,
    so a document this writer would emit but the hub would reject fails here,
    next to the code that produced it, rather than in CI on a finished 445-trial
    run.
    """
    try:
        document = build(
            trial_dir=trial_dir,
            manifest=manifest,
            instruction=instruction,
            session_id=session_id,
            accounting=accounting,
        )
    except Exception:  # noqa: BLE001 -- a lost trajectory is not a failed trial
        logger.exception("could not assemble the ATIF trajectory")
        return None

    try:
        from harbor.models.trajectories.trajectory import Trajectory

        document = Trajectory.model_validate(document).to_json_dict()
    except ImportError:  # pragma: no cover -- harbor is always present in a run
        logger.warning("harbor trajectory model unavailable; writing unvalidated")
    except Exception:  # noqa: BLE001
        logger.exception("assembled trajectory failed ATIF validation")
        return None

    path = logs_dir / "trajectory.json"
    try:
        path.write_text(json.dumps(document, indent=2), encoding="utf-8")
    except OSError:
        logger.exception("could not write %s", path)
        return None
    return path
