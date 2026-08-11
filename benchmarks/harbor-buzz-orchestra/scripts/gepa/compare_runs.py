#!/usr/bin/env python3
"""Compare two harbor-buzz-orchestra jobs task-by-task (GEPA keep/revert evidence).

Usage: compare_runs.py <baseline_job_dir> <candidate_job_dir>
Prints fixed / regressed / still-zero / both-pass tables and a verdict line.
With k=1, per-task flips are noisy (~19% observed on identical configs) —
the verdict is evidence, not proof; require paired swings before keeping.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path


def load(job_dir: str) -> dict[str, list[float]]:
    scores = defaultdict(list)
    for rf in sorted(Path(job_dir).glob("*/result.json")):
        r = json.loads(rf.read_text(errors="replace"))
        task = r.get("task_name") or rf.parent.name.split("__")[0]
        rewards = (r.get("verifier_result") or {}).get("rewards")
        scores[task].append(max(rewards.values()) if rewards else 0.0)
    return scores


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def main(base_dir: str, cand_dir: str) -> None:
    base, cand = load(base_dir), load(cand_dir)
    tasks = sorted(set(base) | set(cand))
    fixed, regressed, stillzero, bothpass = [], [], [], []
    for t in tasks:
        b, c = mean(base.get(t, [])), mean(cand.get(t, []))
        if b == 0 and c > 0:
            fixed.append(t)
        elif b > 0 and c == 0:
            regressed.append(t)
        elif b == 0 and c == 0:
            stillzero.append(t)
        else:
            bothpass.append(t)
    bp = sum(1 for t in base if mean(base[t]) > 0)
    cp = sum(1 for t in cand if mean(cand[t]) > 0)
    print(f"baseline : {bp}/{len(base)} pass  ({Path(base_dir).name})")
    print(f"candidate: {cp}/{len(cand)} pass  ({Path(cand_dir).name})")
    print(f"\nFIXED ({len(fixed)}): {', '.join(fixed) or '—'}")
    print(f"REGRESSED ({len(regressed)}): {', '.join(regressed) or '—'}")
    print(f"STILL-ZERO ({len(stillzero)}): {', '.join(stillzero) or '—'}")
    print(f"BOTH-PASS: {len(bothpass)}")
    delta = cp - bp
    print(f"\nnet: {delta:+d}  — keep only if the fixed set matches the mutation's "
          f"predicted targets and net > flip noise for this subset size")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
