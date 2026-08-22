#!/usr/bin/env python
"""Train the frozen-encoder pairwise outfit ranker (PRD § ML System, Plan A).

    python services/inference/scripts/train_ranker.py
    python services/inference/scripts/train_ranker.py --dims 16 --report-test

Embeds the labelling pool with a frozen DINOv2-S, reduces to a few dozen
dimensions, and fits a linear pairwise ranker on the collected A/B decisions.

The model is deliberately tiny. With ~180 images and ~420 training pairs from a
single rater, anything with real capacity memorises the pool and tells you
nothing. A linear head on a low-rank projection is the largest model this
dataset can honestly support.

    score(image)      = w · P(embed(image))
    P(A preferred)    = sigmoid((score(A) - score(B)) / temperature)

There is no intercept, so the model is antisymmetric by construction: swapping
A and B provably flips the prediction. The PRD asks for swap consistency as an
evaluation metric; here it is a property of the architecture rather than
something to measure and hope for.

Training-only code. It lives outside `src/fitted_inference` because the wheel
ships only the deployable package.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[3]
POOL_DIR = REPO_ROOT / "apps" / "web" / "public" / "label-pool"
DECISIONS_DIR = REPO_ROOT / "data" / "labelling"
ARTIFACT_DIR = REPO_ROOT / "models" / "ranker"
CACHE_PATH = ARTIFACT_DIR / "embeddings.npz"
TEACHER_POOL_DIR = REPO_ROOT / "data" / "teacher-pool"
TEACHER_CACHE_PATH = ARTIFACT_DIR / "teacher-embeddings.npz"

IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
ENCODER = "facebook/dinov2-small"
RANKER_VERSION = "dinov2s-pca-linear-v1"


# --------------------------------------------------------------------------
# Data
# --------------------------------------------------------------------------


@dataclass
class Comparison:
    """One rater decision, in the order the rater actually saw it.

    We deliberately use `shownLeftId`/`shownRightId` rather than parsing the
    pair id. `pairId()` in apps/web/lib/labelling/pairing.ts *sorts* the two
    ids, so the canonical order behind `verdict`/`target` cannot be recovered
    from the id string. The shown fields carry their own orientation and need
    no reconstruction.
    """

    left: str
    right: str
    # 1.0 = left preferred, 0.0 = right preferred, 0.5 = too close to call.
    label: float
    split: str
    rater: str


def load_decisions(
    directory: Path = DECISIONS_DIR, raters: set[str] | None = None
) -> list[Comparison]:
    """Read every rater's JSONL file. One file per rater, merged here.

    Point `directory` at a frozen snapshot when comparing configurations.
    Raters label continuously, so the evaluation splits grow underneath a live
    directory and two runs minutes apart are scored on different data.

    `raters` restricts the set by id. FITTED targets a defined audience, and
    pooling judges who do not share a preference produces a target that no
    single viewer holds — measurably so: see the PRD's inter-rater table.
    """
    files = sorted(directory.glob("decisions.*.jsonl"))
    if not files:
        sys.exit(f"No decision files in {directory}. Collect labels at /label first.")

    verdict_to_label = {"a": 1.0, "b": 0.0, "close": 0.5}
    out: list[Comparison] = []
    unjudgeable = 0

    for file in files:
        for line in file.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if raters is not None and row["raterId"].upper() not in raters:
                continue
            label = verdict_to_label.get(row["shownVerdict"])
            if label is None:
                # "Cannot judge" is a frame-quality signal, not a preference.
                # The PRD excludes these rows from the training target.
                unjudgeable += 1
                continue
            out.append(
                Comparison(
                    left=row["shownLeftId"],
                    right=row["shownRightId"],
                    label=label,
                    split=row["split"],
                    rater=row["raterId"],
                )
            )

    per_rater = Counter(c.rater for c in out)
    present = sorted(per_rater)
    print(
        f"decisions: {len(out)} usable, {unjudgeable} unjudgeable, "
        f"raters={ {r: per_rater[r] for r in present} }"
    )
    if raters is not None:
        missing = sorted(raters - {r.upper() for r in present})
        if missing:
            sys.exit(f"Requested rater(s) with no decisions on file: {', '.join(missing)}")
    if len(present) == 1:
        print(
            "  NOTE: one rater only. Inter-rater agreement is unmeasurable, so\n"
            "  there is no ceiling to compare the test number against."
        )
    return out


def resolve_images(comparisons: list[Comparison]) -> dict[str, Path]:
    """Map every referenced image id to a file on disk.

    Ids are filename stems (see readPool in apps/web/lib/labelling/store.ts),
    so this is a lookup rather than a search.
    """
    needed = {c.left for c in comparisons} | {c.right for c in comparisons}

    on_disk: dict[str, Path] = {}
    if POOL_DIR.is_dir():
        for path in POOL_DIR.iterdir():
            if path.suffix.lower() in IMAGE_EXTENSIONS:
                on_disk[path.stem] = path

    missing = sorted(needed - on_disk.keys())
    if missing:
        print(f"\n{len(missing)} of {len(needed)} labelled images are missing from {POOL_DIR}")
        for stem in missing[:5]:
            print(f"  {stem}")
        if len(missing) > 5:
            print(f"  ... and {len(missing) - 5} more")
        sys.exit(
            "\nThe pool is gitignored, so it does not survive a fresh clone.\n"
            "Restore the exact same photo set and re-ingest:\n"
            "  node scripts/ingest-label-pool.mjs <photo-dir> --clear\n"
            "  node scripts/ingest-label-pool.mjs --fingerprint\n"
            "Ids are hashed from filenames, so a different photo set produces\n"
            "different ids and orphans every decision already collected."
        )

    return {stem: on_disk[stem] for stem in needed}


def image_splits(comparisons: list[Comparison]) -> dict[str, str]:
    """Derive each image's split from the decisions themselves.

    Splits are assigned per subject in TypeScript. Rather than reimplement that
    RNG in Python and risk a silent mismatch, take the split each decision
    recorded. Every pair lies within one split, so both of its images inherit
    it — and a contradiction means the pool changed under the labels.
    """
    splits: dict[str, str] = {}
    for c in comparisons:
        for image in (c.left, c.right):
            previous = splits.setdefault(image, c.split)
            if previous != c.split:
                sys.exit(
                    f"Image {image} appears in both '{previous}' and '{c.split}' pairs.\n"
                    "The pool changed after these labels were collected; re-ingest the\n"
                    "original photo set before training."
                )
    return splits


# --------------------------------------------------------------------------
# Embedding
# --------------------------------------------------------------------------


def embed_pool(
    images: dict[str, Path],
    batch_size: int,
    refresh: bool,
    cache_path: Path = CACHE_PATH,
) -> dict[str, np.ndarray]:
    """Frozen DINOv2-S embeddings, cached by image id.

    Cached because embedding is the slow half (~70 ms/image on CPU) and the
    regularisation sweep below wants to re-run in seconds.
    """
    cached: dict[str, np.ndarray] = {}
    if cache_path.exists() and not refresh:
        with np.load(cache_path) as data:
            cached = {key: data[key] for key in data.files}

    todo = sorted(set(images) - set(cached))
    if not todo:
        print(f"embeddings: {len(cached)} cached, 0 to compute")
        return {stem: cached[stem] for stem in images}

    # Imported late so --help and the data checks above work without torch.
    import torch
    from PIL import Image
    from transformers import AutoModel

    print(f"embeddings: {len(cached)} cached, {len(todo)} to compute with {ENCODER}")
    model = AutoModel.from_pretrained(ENCODER).eval()

    # ImageNet statistics, matching the encoder's own preprocessing.
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)

    def to_tensor(path: Path) -> np.ndarray:
        """Letterbox to square, then resize to 224.

        The stock processor resizes the short edge and centre-crops, which
        slices the shoes or the head off a full-body outfit photo — exactly
        the evidence being judged. Padding preserves the whole garment at the
        cost of some border.
        """
        image = Image.open(path).convert("RGB")
        side = max(image.size)
        square = Image.new("RGB", (side, side), (255, 255, 255))
        square.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
        array = np.asarray(square.resize((224, 224), Image.BICUBIC), dtype=np.float32) / 255.0
        return ((array - mean) / std).transpose(2, 0, 1)

    started = time.time()
    with torch.inference_mode():
        for start in range(0, len(todo), batch_size):
            chunk = todo[start : start + batch_size]
            batch = torch.from_numpy(np.stack([to_tensor(images[stem]) for stem in chunk]))
            # CLS token: DINOv2's global image descriptor.
            output = model(pixel_values=batch).last_hidden_state[:, 0].numpy()
            for stem, vector in zip(chunk, output, strict=True):
                cached[stem] = vector.astype(np.float32)
            done = min(start + batch_size, len(todo))
            print(f"  {done}/{len(todo)}  ({(time.time() - started) / done:.2f}s per image)")

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache_path, **cached)
    print(f"  cached to {cache_path.relative_to(REPO_ROOT)}")
    return {stem: cached[stem] for stem in images}


# --------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------


def fit_projection(train_vectors: np.ndarray, dims: int) -> tuple[np.ndarray, np.ndarray]:
    """PCA basis fitted on training images only.

    Fitting on the whole pool would leak held-out images into the
    representation and inflate the test number.
    """
    centre = train_vectors.mean(axis=0)
    _, _, vt = np.linalg.svd(train_vectors - centre, full_matrices=False)
    return centre, vt[:dims]


def project(vectors: np.ndarray, centre: np.ndarray, basis: np.ndarray) -> np.ndarray:
    """Centre, project, and L2-normalise so the ranker sees a bounded scale."""
    reduced = (vectors - centre) @ basis.T
    norms = np.linalg.norm(reduced, axis=1, keepdims=True)
    return reduced / np.maximum(norms, 1e-8)


def fit_ranker(
    x: np.ndarray,
    y: np.ndarray,
    l2: float,
    steps: int = 400,
    prior: np.ndarray | None = None,
) -> np.ndarray:
    """Logistic regression on difference vectors, no intercept.

    Soft labels: a 0.5 "too close to call" contributes genuine information
    (these two outfits are near-equal) and BCE handles it without a special
    case, so ties stay in the training set instead of being thrown away.

    `prior` turns the penalty into a proximal term pulling towards an existing
    weight vector rather than towards zero. That is how the distilled student is
    fine-tuned: the teacher's weights are the starting point, and the few
    hundred human pairs are only allowed to move them so far.
    """
    import torch

    features = torch.from_numpy(x.astype(np.float32))
    targets = torch.from_numpy(y.astype(np.float32))
    anchor = (
        torch.zeros(x.shape[1], dtype=torch.float32)
        if prior is None
        else torch.from_numpy(prior.astype(np.float32))
    )
    weights = anchor.clone().requires_grad_(True)

    optimiser = torch.optim.LBFGS([weights], max_iter=steps, line_search_fn="strong_wolfe")
    loss_fn = torch.nn.BCEWithLogitsLoss()

    def closure() -> torch.Tensor:
        optimiser.zero_grad()
        offset = weights - anchor
        loss = loss_fn(features @ weights, targets) + l2 * offset.dot(offset)
        loss.backward()
        return loss

    optimiser.step(closure)
    return weights.detach().numpy()


def accuracy(x: np.ndarray, y: np.ndarray, weights: np.ndarray) -> tuple[float, int]:
    """Agreement on decided pairs. Ties are excluded — neither side is correct."""
    decided = y != 0.5
    if not decided.any():
        return float("nan"), 0
    predicted = (x[decided] @ weights) > 0
    return float((predicted == (y[decided] > 0.5)).mean()), int(decided.sum())


def wilson_interval(correct: float, n: int, z: float = 1.96) -> tuple[float, float]:
    """Wilson score interval. With 80-odd test pairs the CI is the honest number."""
    if n == 0:
        return (float("nan"), float("nan"))
    centre = (correct + z * z / (2 * n)) / (1 + z * z / n)
    spread = z * math.sqrt(correct * (1 - correct) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return (max(0.0, centre - spread), min(1.0, centre + spread))


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def build_matrix(
    comparisons: list[Comparison], embeddings: dict[str, np.ndarray]
) -> tuple[np.ndarray, np.ndarray]:
    """Difference vectors and their labels."""
    x = np.stack([embeddings[c.left] - embeddings[c.right] for c in comparisons])
    y = np.array([c.label for c in comparisons], dtype=np.float32)
    return x, y


def load_teacher(path: Path, tie_margin: float) -> list[Comparison]:
    """VLM teacher preferences from distil_teacher.py.

    The teacher emits a continuous score margin. Anything inside `tie_margin`
    is recorded as a tie rather than forced to a side: a two-point gap on a
    0-100 rubric is the judge being indifferent, and training the student to
    call it confidently teaches it noise.
    """
    if not path.exists():
        sys.exit(f"No teacher labels at {path}. Run distil_teacher.py first.")

    out: list[Comparison] = []
    ties = 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        margin = row["margin"]
        if abs(margin) < tie_margin:
            label = 0.5
            ties += 1
        else:
            label = 1.0 if margin > 0 else 0.0
        out.append(
            Comparison(
                left=row["leftId"], right=row["rightId"], label=label, split="teacher", rater="vlm"
            )
        )
    print(f"teacher: {len(out)} pairs ({ties} within the {tie_margin}-point tie margin)")
    return out


def resolve_teacher_images(comparisons: list[Comparison], pool: Path) -> dict[str, Path]:
    needed = {c.left for c in comparisons} | {c.right for c in comparisons}
    missing = sorted(stem for stem in needed if not (pool / stem).exists())
    if missing:
        sys.exit(
            f"{len(missing)} teacher images are missing from {pool} "
            f"(e.g. {missing[0]}). Re-run prepare_teacher_pool.py with the same --seed."
        )
    return {stem: pool / stem for stem in needed}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dims", type=int, default=32, help="PCA dimensions (default: 32)")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--refresh", action="store_true", help="recompute cached embeddings")
    parser.add_argument(
        "--report-test",
        action="store_true",
        help="evaluate on the held-out test split. Run this ONCE, at the end.",
    )
    parser.add_argument(
        "--teacher",
        type=Path,
        help="teacher.jsonl from distil_teacher.py. Pretrains the head, then "
        "fine-tunes it on the human pairs (Plan B).",
    )
    parser.add_argument("--teacher-pool", type=Path, default=TEACHER_POOL_DIR)
    parser.add_argument(
        "--decisions-dir",
        type=Path,
        default=DECISIONS_DIR,
        help="frozen snapshot of the rater JSONL files. Use one when "
        "comparing configurations while raters are still labelling.",
    )
    parser.add_argument(
        "--raters",
        help="comma-separated rater ids to include, e.g. AC,DP. Omit for all.",
    )
    parser.add_argument(
        "--tie-margin",
        type=float,
        default=2.0,
        help="teacher score gaps smaller than this count as ties (default: 2.0)",
    )
    parser.add_argument(
        "--projection",
        choices=("teacher", "train"),
        default="teacher",
        help="which images fit the PCA basis when --teacher is used. 'teacher' "
        "uses the far larger teacher pool; 'train' keeps the label pool's own "
        "basis, isolating the prior's contribution from the basis change.",
    )
    args = parser.parse_args()

    selected = (
        {r.strip().upper() for r in args.raters.split(",") if r.strip()}
        if args.raters
        else None
    )
    comparisons = load_decisions(args.decisions_dir, selected)
    files = resolve_images(comparisons)
    splits = image_splits(comparisons)
    embeddings = embed_pool(files, args.batch_size, args.refresh)

    by_split = {
        name: [c for c in comparisons if c.split == name] for name in ("train", "val", "test")
    }
    counts = {name: len(rows) for name, rows in by_split.items()}
    images_per_split = {
        name: sum(1 for image, split in splits.items() if split == name)
        for name in ("train", "val", "test")
    }
    print(f"pairs: {counts}")
    print(f"images: {images_per_split}")

    teacher: list[Comparison] = []
    teacher_reduced: dict[str, np.ndarray] = {}
    prior: np.ndarray | None = None

    if args.teacher:
        # The teacher pool is tens of thousands of images, so it estimates the
        # embedding manifold far better than 128 labelled photos can. Fitting
        # the projection there is not leakage: the pools are disjoint.
        teacher = load_teacher(args.teacher, args.tie_margin)
        teacher_files = resolve_teacher_images(teacher, args.teacher_pool)
        teacher_embeddings = embed_pool(
            teacher_files, args.batch_size, args.refresh, TEACHER_CACHE_PATH
        )
        if args.projection == "teacher":
            source = np.stack(list(teacher_embeddings.values()))
        else:
            train_images = sorted(image for image, split in splits.items() if split == "train")
            source = np.stack([embeddings[i] for i in train_images])
        print(f"projection fitted on {len(source)} {args.projection}-pool images")
        centre, basis = fit_projection(source, args.dims)
        teacher_reduced = dict(
            zip(
                teacher_embeddings,
                project(np.stack(list(teacher_embeddings.values())), centre, basis),
                strict=True,
            )
        )
    else:
        train_images = sorted(image for image, split in splits.items() if split == "train")
        centre, basis = fit_projection(np.stack([embeddings[i] for i in train_images]), args.dims)

    reduced = {stem: v for stem, v in zip(
        embeddings, project(np.stack(list(embeddings.values())), centre, basis), strict=True
    )}

    x_train, y_train = build_matrix(by_split["train"], reduced)
    x_val, y_val = build_matrix(by_split["val"], reduced)

    if args.teacher:
        x_teacher, y_teacher = build_matrix(teacher, teacher_reduced)
        print(f"\npretraining on {len(y_teacher)} teacher pairs ({args.dims} dims)")
        # Thousands of teacher pairs support a much lighter penalty than a few
        # hundred human ones, so the pretraining step is regularised separately.
        prior = fit_ranker(x_teacher, y_teacher, 0.01)
        teacher_accuracy, teacher_n = accuracy(x_teacher, y_teacher, prior)
        print(f"  teacher fit: {teacher_accuracy:.3f} on n={teacher_n}")
        zero_shot, zero_n = accuracy(x_val, y_val, prior)
        print(f"  BEFORE any human label, on human val: {zero_shot:.3f} (n={zero_n})")
        print("  That number is the honest measure of what distillation bought.")

    print(f"\nsweeping L2 on the validation split ({args.dims} dims)")
    if prior is not None:
        print("  (L2 now pulls towards the teacher's weights, not towards zero)")
    best = (None, -1.0, 0.0)
    for l2 in (0.001, 0.01, 0.03, 0.1, 0.3, 1.0, 3.0, 10.0):
        weights = fit_ranker(x_train, y_train, l2, prior=prior)
        train_accuracy, _ = accuracy(x_train, y_train, weights)
        val_accuracy, val_n = accuracy(x_val, y_val, weights)
        print(f"  l2={l2:<7} train={train_accuracy:.3f}  val={val_accuracy:.3f}  (n={val_n})")
        if val_accuracy > best[1]:
            best = (weights, val_accuracy, l2)

    weights, val_accuracy, l2 = best
    print(f"\nbest: l2={l2}, val={val_accuracy:.3f}")
    print("A coin flip scores 0.500. Treat anything inside the interval as unproven.")

    test_report = None
    if args.report_test:
        x_test, y_test = build_matrix(by_split["test"], reduced)
        test_accuracy, test_n = accuracy(x_test, y_test, weights)
        low, high = wilson_interval(test_accuracy, test_n)
        print(f"\nTEST: {test_accuracy:.3f}  95% CI [{low:.3f}, {high:.3f}]  (n={test_n})")
        test_report = {"accuracy": test_accuracy, "ci": [low, high], "n": test_n}
    else:
        print("\nTest split untouched. Pass --report-test once the design is frozen.")

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    artifact = ARTIFACT_DIR / "ranker.npz"
    np.savez(artifact, centre=centre, basis=basis, weights=weights)
    (ARTIFACT_DIR / "ranker.json").write_text(
        json.dumps(
            {
                "version": RANKER_VERSION,
                "encoder": ENCODER,
                "dims": args.dims,
                "l2": l2,
                "trainPairs": counts["train"],
                "valAccuracy": val_accuracy,
                "test": test_report,
                "raters": sorted({c.rater for c in comparisons}),
                "ratersRequested": sorted(selected) if selected else "all",
                "teacherPairs": len(teacher) if teacher else 0,
                "projectionFittedOn": (
                    f"{args.projection}-pool" if args.teacher else "train-images"
                ),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"saved {artifact.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
