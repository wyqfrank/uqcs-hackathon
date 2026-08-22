#!/usr/bin/env python
"""Score every available judge on the same held-out human-labelled pairs.

    python services/inference/scripts/benchmark_judges.py --raters AC,DP --split test

Answers the question the distillation work left open: the student was trained on
Gemini's judgements of *Fashion144k* images, and Gemini has never been measured
against the project's own raters. Without that number there is no way to tell
whether the ranker underperforms because the linear head is lossy or because the
teacher it copied is itself weak.

Three judges are scored on identical pairs:

  human   - one rater predicting the other, the practical ceiling
  gemini  - the production assessor, run directly on the labelled pool
  ranker  - the trained student in models/ranker

Only pairs both raters judged decisively enter the human comparison, so every
judge is measured on the same evidence.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import json
import os
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "services" / "inference" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

POOL_DIR = REPO_ROOT / "apps" / "web" / "public" / "label-pool"
DECISIONS_DIR = REPO_ROOT / "data" / "labelling"
ARTIFACT_DIR = REPO_ROOT / "models" / "ranker"
CACHE_PATH = ARTIFACT_DIR / "judge-benchmark.jsonl"

MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}

from distil_teacher import load_dotenv  # noqa: E402

from fitted_inference.scoring import visual_fit_score  # noqa: E402
from fitted_inference.vlm import (  # noqa: E402
    VLM_PROMPTS,
    GeminiVlmProvider,
    VlmProviderError,
    VlmProviderQuotaError,
)


def load_pairs(directory: Path, raters: set[str], split: str) -> dict[tuple[str, str], dict]:
    """Canonical pair -> {rater: bool 'the canonically-first image won'}."""
    by_pair: dict[tuple[str, str], dict] = collections.defaultdict(dict)
    for file in directory.glob("decisions.*.jsonl"):
        for line in file.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if row["raterId"].upper() not in raters or row["split"] != split:
                continue
            if row["shownVerdict"] not in ("a", "b"):
                continue
            left, right = row["shownLeftId"], row["shownRightId"]
            winner = left if row["shownVerdict"] == "a" else right
            key = (min(left, right), max(left, right))
            by_pair[key][row["raterId"].upper()] = winner == key[0]
    return dict(by_pair)


def resolve(stem: str) -> Path:
    for extension in MIME:
        candidate = POOL_DIR / f"{stem}{extension}"
        if candidate.exists():
            return candidate
    sys.exit(f"Image {stem} is not in {POOL_DIR}.")


async def run_gemini(pairs: list[tuple[str, str]], concurrency: int, out: Path) -> dict:
    """Judge each pair with the production assessor. Resumable via `out`."""
    done: dict[str, float] = {}
    if out.exists():
        for line in out.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                done[row["pairId"]] = row["margin"]

    todo = [p for p in pairs if f"{p[0]}|{p[1]}" not in done]
    print(f"gemini: {len(done)} cached, {len(todo)} to judge")
    if todo:
        load_dotenv(REPO_ROOT / ".env")
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            sys.exit("GEMINI_API_KEY is not set; add it to the repo's .env.")

        provider = GeminiVlmProvider(
            api_key=api_key,
            model=os.getenv("FITTED_VLM_MODEL", "gemini-3.6-flash"),
            prompt=VLM_PROMPTS[os.getenv("FITTED_VLM_PROMPT_VERSION", "v2")],
            media_resolution=os.getenv("FITTED_VLM_MEDIA_RESOLUTION", "high"),
            timeout_seconds=30.0,
        )
        handle = out.open("a", encoding="utf-8")
        semaphore = asyncio.Semaphore(concurrency)
        lock = asyncio.Lock()
        stop = asyncio.Event()
        counters = collections.Counter()

        async def judge(first: str, second: str) -> None:
            if stop.is_set():
                return
            async with semaphore:
                if stop.is_set():
                    return
                images = []
                for stem in (first, second):
                    path = resolve(stem)
                    images.append((path.read_bytes(), MIME[path.suffix.lower()]))
                try:
                    assessment = await provider.assess(
                        player_a_images=[images[0]], player_b_images=[images[1]]
                    )
                except VlmProviderQuotaError:
                    stop.set()
                    return
                except VlmProviderError:
                    counters["failed"] += 1
                    return
                a, b = assessment.player_a, assessment.player_b
                if a.component_quality is None or b.component_quality is None:
                    counters["unusable"] += 1
                    return
                margin = visual_fit_score(
                    component_quality=a.component_quality,
                    outfit_coordination=a.outfit_coordination,
                    body_fit=a.body_fit,
                ) - visual_fit_score(
                    component_quality=b.component_quality,
                    outfit_coordination=b.outfit_coordination,
                    body_fit=b.body_fit,
                )
                async with lock:
                    handle.write(
                        json.dumps({"pairId": f"{first}|{second}", "margin": margin}) + "\n"
                    )
                    handle.flush()
                    done[f"{first}|{second}"] = margin
                    counters["ok"] += 1
                    if counters["ok"] % 25 == 0:
                        print(f"  {counters['ok']}/{len(todo)}")

        try:
            await asyncio.gather(*(judge(a, b) for a, b in todo))
        finally:
            handle.close()
        if stop.is_set():
            print("  STOPPED on quota; re-run to resume.")
        print(f"  ok={counters['ok']} unusable={counters['unusable']} failed={counters['failed']}")
    return done


def ranker_scores() -> tuple[dict, callable]:
    art = np.load(ARTIFACT_DIR / "ranker.npz")
    emb = dict(np.load(ARTIFACT_DIR / "embeddings.npz"))
    centre, basis, weights = art["centre"], art["basis"], art["weights"]

    def score(stem: str) -> float:
        z = (emb[stem] - centre) @ basis.T
        return float((z / max(np.linalg.norm(z), 1e-8)) @ weights)

    return emb, score


def wilson(p: float, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    spread = z * ((p * (1 - p) / n + z * z / (4 * n * n)) ** 0.5) / (1 + z * z / n)
    return (max(0.0, centre - spread), min(1.0, centre + spread))


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raters", default="AC,DP")
    parser.add_argument("--split", default="test")
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--decisions-dir", type=Path, default=DECISIONS_DIR)
    parser.add_argument("--cache", type=Path, default=CACHE_PATH)
    args = parser.parse_args()

    raters = {r.strip().upper() for r in args.raters.split(",") if r.strip()}
    if len(raters) != 2:
        sys.exit("Exactly two raters are needed to measure a human-vs-human ceiling.")
    first_rater, second_rater = sorted(raters)

    by_pair = load_pairs(args.decisions_dir, raters, args.split)
    both = {k: v for k, v in by_pair.items() if len(v) == 2}
    print(
        f"{args.split} pairs judged decisively by both "
        f"{first_rater} and {second_rater}: {len(both)}"
    )
    if not both:
        sys.exit("No overlapping pairs; nothing to compare.")

    ordered = sorted(both)
    margins = await run_gemini(ordered, args.concurrency, args.cache)
    _, score = ranker_scores()

    rows = []
    for key in ordered:
        pair_id = f"{key[0]}|{key[1]}"
        if pair_id not in margins:
            continue
        rows.append(
            {
                first_rater: both[key][first_rater],
                second_rater: both[key][second_rater],
                "gemini": margins[pair_id] > 0,
                "ranker": score(key[0]) > score(key[1]),
            }
        )

    n = len(rows)
    print(f"\nscored on {n} pairs\n")

    def report(name: str, hits: int, total: int) -> None:
        p = hits / total
        low, high = wilson(p, total)
        print(f"  {name:<28} {p:.3f}  95% CI [{low:.3f}, {high:.3f}]  n={total}")

    human_agree = sum(1 for r in rows if r[first_rater] == r[second_rater])
    print("CEILING")
    report(f"{first_rater} predicting {second_rater}", human_agree, n)

    print("\nJUDGES (averaged over both raters)")
    for judge in ("gemini", "ranker"):
        hits = sum((r[judge] == r[first_rater]) + (r[judge] == r[second_rater]) for r in rows)
        report(judge, hits, 2 * n)

    clean = [r for r in rows if r[first_rater] == r[second_rater]]
    if clean:
        print(f"\nON THE {len(clean)} PAIRS WHERE BOTH RATERS AGREE (humans score 1.000)")
        for judge in ("gemini", "ranker"):
            hits = sum(1 for r in clean if r[judge] == r[first_rater])
            report(judge, hits, len(clean))

    agree = sum(1 for r in rows if r["gemini"] == r["ranker"])
    print(f"\nstudent-teacher agreement: {agree / n:.3f}  (how much of Gemini the ranker captured)")


if __name__ == "__main__":
    asyncio.run(main())
