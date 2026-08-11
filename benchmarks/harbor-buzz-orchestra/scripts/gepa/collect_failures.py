#!/usr/bin/env python3
"""Collect failure evidence from a harbor-buzz-orchestra job for GEPA reflection.

Buzz variant of goose-harbor's collect_failures.py: same job contract
(``jobs/<job>/<task>__<id>/result.json``), but the trace section reads the
*channel transcript* (``agent/buzz/transcript.json``) plus per-agent stdout
tails — because our dominant failure modes are coordination-shaped (who woke
whom, who went silent, who DONE'd without verification), not just
terminal-shaped.

Usage: collect_failures.py <job_dir> [--all]  (--all includes passes)
"""
import json
import sys
from pathlib import Path

TRANSCRIPT_TAIL_MSGS = 30
STDOUT_TAIL = 2000
VERIFIER_TAIL = 2000


def reward_of(r: dict) -> float | None:
    vr = r.get("verifier_result") or {}
    rewards = vr.get("rewards")
    if not rewards:
        return None  # verifier never wrote rewards (timeout) — treat as 0
    return max(rewards.values())


def transcript_summary(trial_dir: Path) -> tuple[str, dict]:
    """Render the channel transcript tail + coordination stats."""
    tf = trial_dir / "agent" / "buzz" / "transcript.json"
    if not tf.exists():
        return "(no transcript)", {}
    try:
        msgs = json.loads(tf.read_text(errors="replace"))
    except Exception:
        return "(unreadable transcript)", {}
    if isinstance(msgs, dict):
        msgs = msgs.get("messages", [])
    stats: dict[str, int] = {}
    lines = []
    for m in msgs:
        author = m.get("author") or m.get("pubkey", "?")[:8]
        stats[author] = stats.get(author, 0) + 1
    for m in msgs[-TRANSCRIPT_TAIL_MSGS:]:
        author = m.get("author") or m.get("pubkey", "?")[:8]
        content = (m.get("content") or "").replace("\n", " ")[:220]
        lines.append(f"[{author}] {content}")
    return "\n".join(lines), stats


def stdout_tails(trial_dir: Path) -> dict[str, str]:
    out = {}
    buzz = trial_dir / "agent" / "buzz"
    if buzz.exists():
        for f in sorted(buzz.glob("*-*.stdout.log")):
            out[f.name] = f.read_text(errors="replace")[-STDOUT_TAIL:]
    return out


def collect(job_dir: str, include_passes: bool = False) -> None:
    job_path = Path(job_dir)
    entries = []
    for result_file in sorted(job_path.glob("*/result.json")):
        trial_dir = result_file.parent
        r = json.loads(result_file.read_text(errors="replace"))
        reward = reward_of(r)
        passed = (reward or 0.0) > 0
        if passed and not include_passes:
            continue
        exc = (r.get("exception_info") or {}).get("exception_type")
        verifier = ""
        vs = trial_dir / "verifier" / "test-stdout.txt"
        if vs.exists():
            verifier = vs.read_text(errors="replace")[-VERIFIER_TAIL:]
        tr, stats = transcript_summary(trial_dir)
        entries.append({
            "task": r.get("task_name") or trial_dir.name.split("__")[0],
            "trial": trial_dir.name,
            "reward": reward,
            "exception": exc,
            "verifier": verifier,
            "transcript": tr,
            "msg_counts": stats,
            "stdout": stdout_tails(trial_dir),
        })

    print(f"# GEPA failure evidence: {len(entries)} trials from {job_path.name}\n")
    for e in entries:
        print(f"## {e['task']}  ({e['trial']})")
        print(f"reward={e['reward']}  exception={e['exception']}  msgs={e['msg_counts']}")
        print("\n### Channel transcript (tail)")
        print(f"```\n{e['transcript']}\n```")
        for name, tail in e["stdout"].items():
            print(f"\n### {name} (tail)")
            print(f"```\n{tail}\n```")
        print("\n### Verifier output")
        print(f"```\n{e['verifier']}\n```")
        print()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    collect(sys.argv[1], include_passes="--all" in sys.argv[2:])
