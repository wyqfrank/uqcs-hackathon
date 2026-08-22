#!/usr/bin/env python
"""Collect VLM teacher preferences over the Fashion144k pool (Plan B, step 2).

    GEMINI_API_KEY=... python services/inference/scripts/distil_teacher.py --pairs 2000

Replaces Fashion144k's engagement votes with judgements from the *same* Gemini
assessor that decides a real battle, using the same production prompt and
rubric. The student trained on these labels therefore approximates the judge it
has to agree with at finalisation — which is the point. The live estimate should
predict the final verdict, not some other notion of outfit quality.

The run is resumable and quota-aware. Every completed pair is appended to the
output immediately, an interrupted run continues where it stopped, and an
exhausted quota stops the run cleanly instead of burning retries against a wall.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "services" / "inference" / "src"))

POOL_DIR = REPO_ROOT / "data" / "teacher-pool"
OUTPUT_PATH = REPO_ROOT / "data" / "labelling" / "teacher.jsonl"

from fitted_inference.scoring import visual_fit_score  # noqa: E402
from fitted_inference.vlm import (  # noqa: E402
    VLM_PROMPTS,
    GeminiVlmProvider,
    VlmProviderError,
    VlmProviderQuotaError,
)


def load_dotenv(path: Path) -> None:
    """Fill missing environment variables from the repo's .env.

    `scripts/dev.mjs` loads .env for the dev servers, but a script run directly
    never sees it — so a key that is plainly present in the file would look
    absent. Existing environment variables win, matching how dev.mjs behaves.
    """
    if not path.exists():
        return
    # Collect first so a repeated name resolves the way Node's loadEnvFile
    # resolves it — last assignment wins. Reading first-wins here would make
    # the same .env mean different things to the service and to this script.
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        name = name.strip()
        value = value.strip().strip('"').strip("'")
        if name and value:
            values[name] = value
    for name, value in values.items():
        # A variable already exported for this shell still outranks the file.
        if name not in os.environ:
            os.environ[name] = value


def sample_pairs(images: list[str], count: int, seed: int) -> list[tuple[str, str]]:
    """Deterministic distinct pairs, spreading appearances across the pool.

    Sampling with replacement would let a handful of images dominate the
    training signal. Walking a shuffled list in steps keeps every image's
    appearance count within one of every other's.
    """
    rng = random.Random(seed)
    order = list(images)
    rng.shuffle(order)

    pairs: set[tuple[str, str]] = set()
    stride = 1
    index = 0
    while len(pairs) < count:
        left = order[index % len(order)]
        right = order[(index + stride) % len(order)]
        if left != right:
            pairs.add((left, right) if left < right else (right, left))
        index += 1
        if index % len(order) == 0:
            # Exhausted this offset; widen the stride for a fresh set of pairs.
            stride += 1
            if stride >= len(order):
                break
    return sorted(pairs)[:count]


def pair_id(left: str, right: str) -> str:
    return f"{left}|{right}"


def load_done(path: Path) -> set[str]:
    if not path.exists():
        return set()
    done = set()
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            done.add(json.loads(line)["pairId"])
    return done


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pairs", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--model", default=os.getenv("FITTED_VLM_MODEL", "gemini-3.6-flash"))
    parser.add_argument("--timeout", type=float, default=30.0)
    # Defaults mirror the service's own environment. A teacher judging under
    # different settings than the finalisation path is a different judge, and
    # the student would be distilling something the product never runs.
    parser.add_argument(
        "--prompt-version", default=os.getenv("FITTED_VLM_PROMPT_VERSION", "v2")
    )
    parser.add_argument(
        "--media-resolution",
        default=os.getenv("FITTED_VLM_MEDIA_RESOLUTION", "high"),
        help="'high' matches production; 'low' costs less quota per pair",
    )
    parser.add_argument("--pool", type=Path, default=POOL_DIR)
    parser.add_argument("--out", type=Path, default=OUTPUT_PATH)
    args = parser.parse_args()

    load_dotenv(REPO_ROOT / ".env")
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        sys.exit(
            f"GEMINI_API_KEY is not set.\n"
            f"Add a GEMINI_API_KEY=... line to {REPO_ROOT / '.env'} (gitignored),\n"
            f"or export it for this shell."
        )

    if not args.pool.is_dir():
        sys.exit(f"No teacher pool at {args.pool}. Run prepare_teacher_pool.py first.")
    images = sorted(p.name for p in args.pool.glob("*.webp"))
    if len(images) < 2:
        sys.exit(f"Teacher pool has {len(images)} images; need at least 2.")

    pairs = sample_pairs(images, args.pairs, args.seed)
    done = load_done(args.out)
    todo = [p for p in pairs if pair_id(*p) not in done]
    print(
        f"pool={len(images)} images  pairs={len(pairs)}  "
        f"already done={len(done)}  todo={len(todo)}"
    )
    if not todo:
        print("Nothing to do.")
        return

    prompt = VLM_PROMPTS.get(args.prompt_version)
    if prompt is None:
        sys.exit(
            f"Unknown prompt version {args.prompt_version!r}. "
            f"Available: {', '.join(sorted(VLM_PROMPTS))}"
        )
    print(
        f"teacher: {args.model}, prompt {args.prompt_version}, "
        f"media resolution {args.media_resolution}"
    )

    provider = GeminiVlmProvider(
        api_key=api_key,
        model=args.model,
        prompt=prompt,
        media_resolution=args.media_resolution,
        timeout_seconds=args.timeout,
    )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    handle = args.out.open("a", encoding="utf-8")
    semaphore = asyncio.Semaphore(args.concurrency)
    write_lock = asyncio.Lock()
    quota_hit = asyncio.Event()
    counters = {"ok": 0, "unusable": 0, "failed": 0}
    started = time.time()

    async def judge(left: str, right: str) -> None:
        if quota_hit.is_set():
            return
        async with semaphore:
            if quota_hit.is_set():
                return
            left_bytes = (args.pool / left).read_bytes()
            right_bytes = (args.pool / right).read_bytes()
            try:
                assessment = await provider.assess(
                    player_a_images=[(left_bytes, "image/webp")],
                    player_b_images=[(right_bytes, "image/webp")],
                )
            except VlmProviderQuotaError:
                # Retrying is guaranteed to fail. Stop the whole run; the
                # output file already holds everything completed so far.
                quota_hit.set()
                return
            except VlmProviderError:
                counters["failed"] += 1
                return

            a, b = assessment.player_a, assessment.player_b
            if a.component_quality is None or b.component_quality is None:
                # One side was unusable, so there is no preference to learn.
                counters["unusable"] += 1
                return

            score_a = visual_fit_score(
                component_quality=a.component_quality,
                outfit_coordination=a.outfit_coordination,
                body_fit=a.body_fit,
            )
            score_b = visual_fit_score(
                component_quality=b.component_quality,
                outfit_coordination=b.outfit_coordination,
                body_fit=b.body_fit,
            )
            row = {
                "pairId": pair_id(left, right),
                "leftId": left,
                "rightId": right,
                "scoreA": score_a,
                "scoreB": score_b,
                # Raw margin is kept so training can weight confident pairs or
                # treat near-ties as ties, without re-querying the teacher.
                "margin": score_a - score_b,
                "frameQualityA": a.frame_quality,
                "frameQualityB": b.frame_quality,
                "model": provider.model_version,
            }
            async with write_lock:
                handle.write(json.dumps(row) + "\n")
                handle.flush()
                counters["ok"] += 1
                total = counters["ok"]
                if total % 25 == 0:
                    rate = total / (time.time() - started)
                    remaining = (len(todo) - total) / rate / 60 if rate else 0
                    print(
                        f"  {total}/{len(todo)} ok  {counters['unusable']} unusable  "
                        f"{counters['failed']} failed  ~{remaining:.0f} min left"
                    )

    try:
        await asyncio.gather(*(judge(left, right) for left, right in todo))
    finally:
        handle.close()

    try:
        destination = args.out.relative_to(REPO_ROOT)
    except ValueError:
        destination = args.out
    print(
        f"\nwrote {counters['ok']} teacher labels to {destination}\n"
        f"unusable={counters['unusable']}  failed={counters['failed']}"
    )
    if quota_hit.is_set():
        print(
            "\nSTOPPED: the Gemini quota is exhausted. Everything above is saved —\n"
            "re-run the same command after the quota resets and it resumes."
        )


if __name__ == "__main__":
    asyncio.run(main())
