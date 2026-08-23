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
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from ranker_artifact import (
    ACTIVATIONS,
    CALIBRATION_QUANTILES,
    load_scorer,
    numpy_activation,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
POOL_DIR = REPO_ROOT / "apps" / "web" / "public" / "label-pool"
DECISIONS_DIR = REPO_ROOT / "data" / "labelling"
ARTIFACT_DIR = REPO_ROOT / "models" / "ranker"
CACHE_PATH = ARTIFACT_DIR / "embeddings.npz"
TEACHER_POOL_DIR = REPO_ROOT / "data" / "teacher-pool"
TEACHER_CACHE_PATH = ARTIFACT_DIR / "teacher-embeddings.npz"

IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
ENCODER = "facebook/dinov2-small"
RANKER_VERSIONS = {"linear": "dinov2s-pca-linear-v1", "mlp": "dinov2s-pca-mlp-v1"}


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


def _torch_activation(name: str):
    import torch

    if name == "tanh":
        return torch.tanh
    if name == "relu":
        return torch.relu
    if name == "gelu":
        # tanh-approximate form so the numpy scorer (ranker_artifact.numpy_activation)
        # can match it exactly without an erf dependency; torch's exact-erf gelu
        # differs from this by <1e-3 everywhere, immaterial next to the effect
        # being measured.
        return lambda x: torch.nn.functional.gelu(x, approximate="tanh")
    raise ValueError(f"unknown activation {name!r}, expected one of {ACTIVATIONS}")


def fit_head(
    z_left: np.ndarray,
    z_right: np.ndarray,
    y: np.ndarray,
    l2: float,
    *,
    head: str = "linear",
    hidden: int = 16,
    activation: str = "relu",
    prior: dict[str, np.ndarray] | None = None,
    seed: int = 0,
    steps: int = 400,
) -> dict[str, np.ndarray]:
    """Fit a per-image scorer f(z), trained on the margin f(z_left) - f(z_right).

    A per-image scorer rather than a function of the difference vector, so
    `margin(a, b) == -margin(b, a)` by construction (antisymmetry survives the
    head change for free) and the fitted parameters can score one image alone
    (what benchmark_judges.py and the live path both need).

    Soft labels: a 0.5 "too close to call" contributes genuine information
    (these two outfits are near-equal) and BCE handles it without a special
    case, so ties stay in the training set instead of being thrown away.

    `prior` turns the penalty into a proximal term pulling towards an existing
    parameter dict rather than towards zero, summed tensor-by-tensor. That is
    how the distilled student is fine-tuned: the teacher's parameters are the
    starting point, and the few hundred human pairs are only allowed to move
    them so far.

    linear reuses the original LBFGS body verbatim (same optimiser, same
    steps, same single `step(closure)`) so it is bit-identical to the old
    `fit_ranker`. mlp is non-convex, so LBFGS's strong-Wolfe line search would
    give seed-dependent, occasionally divergent results; full-batch Adam is
    steadier and the dataset is tiny enough that minibatching buys nothing.

    `activation` matters more than it looks. tanh is linear near the origin,
    so an L2 penalty anchoring w1 towards zero (or towards a teacher prior
    fitted the same way) can shrink pre-activations into that regime and
    collapse the whole network onto a linear function — same accuracy, for
    the boring reason that it computed the same thing. relu and gelu have no
    such regime: their kink sits at a fixed point in *input* space, not at a
    weight scale, so shrinking w1 cannot linearise them away. For that reason
    w1/b1 are excluded from the proximal penalty below (see `penalty`) —
    only w2 is still anchored, which is enough to keep the teacher-pretrain
    -> human-fine-tune mechanism intact.
    """
    import torch

    dims = z_left.shape[1]
    left = torch.from_numpy(z_left.astype(np.float32))
    right = torch.from_numpy(z_right.astype(np.float32))
    targets = torch.from_numpy(y.astype(np.float32))
    loss_fn = torch.nn.BCEWithLogitsLoss()
    act = _torch_activation(activation) if head == "mlp" else None

    def zeros() -> dict[str, torch.Tensor]:
        if head == "linear":
            return {"weights": torch.zeros(dims, dtype=torch.float32)}
        return {
            "w1": torch.zeros(hidden, dims, dtype=torch.float32),
            "b1": torch.zeros(hidden, dtype=torch.float32),
            "w2": torch.zeros(hidden, dtype=torch.float32),
        }

    anchor = zeros()
    if prior is not None:
        anchor = {key: torch.from_numpy(prior[key].astype(np.float32)) for key in anchor}

    torch.manual_seed(seed)
    params = {key: value.clone() for key, value in anchor.items()}
    if head == "mlp" and prior is None:
        # Zero-init hidden weights never break symmetry (every unit computes
        # the same gradient), so the first fit needs a small random kick.
        # Once a prior exists it is itself broken-symmetric, and fine-tuning
        # should start exactly there rather than perturb it further.
        params["w1"] = torch.empty(hidden, dims).normal_(std=0.2)
    for value in params.values():
        value.requires_grad_(True)

    def score(z: torch.Tensor) -> torch.Tensor:
        if head == "linear":
            return z @ params["weights"]
        pre = z @ params["w1"].T + params["b1"]
        return act(pre) @ params["w2"]

    def penalty() -> torch.Tensor:
        total = torch.zeros(())
        for key, value in params.items():
            if head == "mlp" and key in ("w1", "b1"):
                # Excluded, not just weakened: any positive coefficient here
                # still pulls pre-activations towards zero, which is exactly
                # the mechanism that collapses tanh onto the identity.
                continue
            offset = value - anchor[key]
            total = total + offset.flatten().dot(offset.flatten())
        return l2 * total

    def loss() -> torch.Tensor:
        margin = score(left) - score(right)
        return loss_fn(margin, targets) + penalty()

    if head == "linear":
        optimiser = torch.optim.LBFGS(
            list(params.values()), max_iter=steps, line_search_fn="strong_wolfe"
        )

        def closure() -> torch.Tensor:
            optimiser.zero_grad()
            value = loss()
            value.backward()
            return value

        optimiser.step(closure)
    else:
        optimiser = torch.optim.Adam(list(params.values()), lr=1e-2)
        for _ in range(1500):
            optimiser.zero_grad()
            value = loss()
            value.backward()
            optimiser.step()

    return {key: value.detach().numpy() for key, value in params.items()}


def make_scorer(params: dict[str, np.ndarray], head: str, activation: str = "relu"):
    """Vectorised numpy f(z) -> score from a fitted parameter dict."""
    if head == "linear":
        weights = params["weights"]
        return lambda z: z @ weights

    w1, b1, w2 = params["w1"], params["b1"], params["w2"]
    act = numpy_activation(activation)

    def scorer(z: np.ndarray) -> np.ndarray:
        return act(z @ w1.T + b1) @ w2

    return scorer


def fit_best_of_seeds(
    z_left: np.ndarray,
    z_right: np.ndarray,
    y: np.ndarray,
    l2: float,
    *,
    head: str,
    hidden: int,
    activation: str = "relu",
    prior: dict[str, np.ndarray] | None,
    seeds: int,
    select_left: np.ndarray,
    select_right: np.ndarray,
    select_y: np.ndarray,
) -> tuple[dict[str, np.ndarray], int]:
    """Fit `seeds` random restarts, keep the one scoring best on a held set.

    Only the mlp branch actually varies with seed: LBFGS on the linear head
    is a deterministic convex fit from a fixed starting point, so every
    restart returns identical weights and this is a single fit in disguise.
    Selection uses the human validation split throughout (never the teacher
    held-out split, even when fitting the teacher prior) so the number this
    experiment reports is never also the number used to pick the model.
    """
    candidate_seeds = range(seeds) if head == "mlp" else (0,)
    best_params: dict[str, np.ndarray] | None = None
    best_score = -1.0
    best_seed = 0
    for seed in candidate_seeds:
        params = fit_head(
            z_left, z_right, y, l2,
            head=head, hidden=hidden, activation=activation, prior=prior, seed=seed,
        )
        scorer = make_scorer(params, head, activation)
        score, _ = accuracy(select_left, select_right, select_y, scorer)
        if score > best_score:
            best_params, best_score, best_seed = params, score, seed
    assert best_params is not None
    return best_params, best_seed


def collapse_diagnostic(
    params: dict[str, np.ndarray],
    activation: str,
    pool_z: np.ndarray,
    linear_score: Callable[[np.ndarray], np.ndarray] | None = None,
) -> dict:
    """Whether a fitted MLP is actually using its non-linearity.

    An MLP that fits the same accuracy as the linear head is not evidence
    against a non-linear function class unless it actually computed a
    non-linear function. tanh flattens to the identity near the origin, so
    a small enough w1 (exactly what an L2 penalty anchored at zero produces)
    collapses the network onto the linear solution — same accuracy, for the
    boring reason that it computed the same thing.

    Three checks, over every pool image (`pool_z`, already projected):
    - mean/max |pre-activation|: how far the network actually sits from the
      origin, where every one of these activations is approximately linear.
    - the fraction of the score's own variance a straight line through z
      cannot already explain (an OLS fit of the MLP's scores onto z; a
      collapsed network has near-zero residual because it IS linear in z).
    - correlation with a separately-fitted linear model's scores on the same
      images, when one is supplied. Values near 1 mean the two models are
      making the same ranking decisions — not proof of collapse by itself
      (two very different functions could still rank similarly) but taken
      together with the other two numbers, >0.99 here is the same signature
      reported against the earlier tanh runs.
    """
    w1, b1, w2 = params["w1"], params["b1"], params["w2"]
    pre = pool_z @ w1.T + b1
    act = numpy_activation(activation)
    scores = act(pre) @ w2

    design = np.hstack([pool_z, np.ones((pool_z.shape[0], 1))])
    coeffs, *_ = np.linalg.lstsq(design, scores, rcond=None)
    residual = scores - design @ coeffs
    total_std = float(np.std(scores))
    nonlinear_fraction = float(np.std(residual)) / total_std if total_std > 1e-12 else 0.0

    result = {
        "nImages": int(pool_z.shape[0]),
        "meanAbsPreActivation": float(np.abs(pre).mean()),
        "maxAbsPreActivation": float(np.abs(pre).max()),
        "nonlinearStdFraction": nonlinear_fraction,
    }
    if linear_score is not None:
        linear_scores = linear_score(pool_z)
        if total_std > 1e-12 and np.std(linear_scores) > 1e-12:
            corr = float(np.corrcoef(scores, linear_scores)[0, 1])
        else:
            corr = float("nan")
        result["corrWithLinear"] = corr
        result["collapsed"] = bool(corr > 0.99)
    return result


def accuracy(
    z_left: np.ndarray, z_right: np.ndarray, y: np.ndarray, scorer
) -> tuple[float, int]:
    """Agreement on decided pairs. Ties are excluded — neither side is correct."""
    decided = y != 0.5
    if not decided.any():
        return float("nan"), 0
    margin = scorer(z_left[decided]) - scorer(z_right[decided])
    predicted = margin > 0
    return float((predicted == (y[decided] > 0.5)).mean()), int(decided.sum())


def json_number(value: float) -> float | None:
    """`None` for a non-finite measurement, because `NaN` is not valid JSON.

    An empty split has no accuracy and no interval, and `accuracy` /
    `wilson_interval` say so with NaN. Python's json module happily writes a
    bare `NaN` literal that every strict reader of ranker.json rejects, so the
    absence is recorded as null instead.
    """
    return value if math.isfinite(value) else None


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


def build_pairs(
    comparisons: list[Comparison], embeddings: dict[str, np.ndarray]
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Left and right embeddings kept separate, plus labels.

    The old `build_matrix` collapsed each pair to `emb[left] - emb[right]`,
    which only works because a linear head is itself linear in that
    difference. A per-image scorer needs both sides individually so it can
    also be called pointwise, on one image, outside training.
    """
    if not comparisons:
        # np.stack rejects an empty sequence; --teacher-holdout 0 (or 1) hits
        # this legitimately by holding out none (or all) of the teacher pairs.
        dims = next(iter(embeddings.values())).shape[0] if embeddings else 0
        empty = np.zeros((0, dims), dtype=np.float32)
        return empty, empty, np.zeros(0, dtype=np.float32)
    z_left = np.stack([embeddings[c.left] for c in comparisons])
    z_right = np.stack([embeddings[c.right] for c in comparisons])
    y = np.array([c.label for c in comparisons], dtype=np.float32)
    return z_left, z_right, y


def teacher_split(
    comparisons: list[Comparison], holdout: float
) -> tuple[list[Comparison], list[Comparison]]:
    """Deterministic train/held-out split of teacher pairs.

    Hashed on the pair id rather than shuffled, so the split is stable across
    runs and independent of file order — two runs made minutes apart, or
    after teacher.jsonl has grown, still hold out the same pairs.
    """
    import hashlib

    train: list[Comparison] = []
    held: list[Comparison] = []
    for c in comparisons:
        digest = hashlib.sha256(f"{c.left}|{c.right}".encode()).digest()
        bucket = digest[0] / 256.0  # deterministic pseudo-uniform in [0, 1)
        (held if bucket < holdout else train).append(c)
    return train, held


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
    parser.add_argument(
        "--head",
        choices=("linear", "mlp"),
        default="linear",
        help="scorer architecture: a weighted sum, or a one-hidden-layer MLP "
        "(default: linear, so the documented repro command keeps working).",
    )
    parser.add_argument(
        "--hidden", type=int, default=16, help="hidden units for --head mlp (default: 16)"
    )
    parser.add_argument(
        "--activation",
        choices=ACTIVATIONS,
        default="relu",
        help="hidden non-linearity for --head mlp (default: relu). tanh is linear "
        "near the origin, so an L2 penalty anchored at zero can shrink it into "
        "that regime and collapse the network onto a linear function; relu's "
        "kink sits at a fixed input, not a weight scale, so it cannot.",
    )
    parser.add_argument(
        "--compare-linear-artifact",
        type=Path,
        help="a previously-saved linear ranker.npz directory to correlate "
        "against in the --head mlp collapse diagnostic. Optional.",
    )
    parser.add_argument(
        "--teacher-holdout",
        type=float,
        default=0.2,
        help="fraction of teacher pairs held out of pretraining, to measure "
        "teacher fit honestly instead of in-sample (default: 0.2)",
    )
    parser.add_argument(
        "--seeds",
        type=int,
        default=3,
        help="random restarts for --head mlp, best kept by validation accuracy "
        "(default: 3; irrelevant to --head linear, whose fit is deterministic)",
    )
    parser.add_argument(
        "--artifact-dir",
        type=Path,
        default=ARTIFACT_DIR,
        help="where to write ranker.npz / ranker.json (default: models/ranker, "
        "the shipped location — point elsewhere for experiment runs)",
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

    x_train_l, x_train_r, y_train = build_pairs(by_split["train"], reduced)
    x_val_l, x_val_r, y_val = build_pairs(by_split["val"], reduced)

    teacher_report = None
    if args.teacher:
        teacher_train, teacher_held = teacher_split(teacher, args.teacher_holdout)
        tt_l, tt_r, tt_y = build_pairs(teacher_train, teacher_reduced)
        th_l, th_r, th_y = build_pairs(teacher_held, teacher_reduced)
        print(
            f"\npretraining on {len(tt_y)} teacher pairs ({args.dims} dims), "
            f"{len(th_y)} held out for an honest fidelity check"
        )
        # Thousands of teacher pairs support a much lighter penalty than a few
        # hundred human ones, so the pretraining step is regularised separately.
        # Selection uses human val, never the teacher held-out set itself — the
        # decisive number must not also be the number used to pick the model.
        prior, prior_seed = fit_best_of_seeds(
            tt_l, tt_r, tt_y, 0.01,
            head=args.head, hidden=args.hidden, activation=args.activation,
            prior=None, seeds=args.seeds,
            select_left=x_val_l, select_right=x_val_r, select_y=y_val,
        )
        prior_scorer = make_scorer(prior, args.head, args.activation)
        teacher_accuracy, teacher_n = accuracy(tt_l, tt_r, tt_y, prior_scorer)
        teacher_held_accuracy, teacher_held_n = accuracy(th_l, th_r, th_y, prior_scorer)
        held_low, held_high = wilson_interval(teacher_held_accuracy, teacher_held_n)
        zero_shot, zero_n = accuracy(x_val_l, x_val_r, y_val, prior_scorer)
        if args.head == "mlp":
            print(f"  best seed: {prior_seed}")
        print(f"  teacher fit (in-sample): {teacher_accuracy:.3f} on n={teacher_n}")
        print(
            f"  teacher fit (held-out):  {teacher_held_accuracy:.3f}  "
            f"95% CI [{held_low:.3f}, {held_high:.3f}]  (n={teacher_held_n})"
        )
        print(f"  BEFORE any human label, on human val: {zero_shot:.3f} (n={zero_n})")
        print("  That number is the honest measure of what distillation bought.")
        teacher_report = {
            "holdout": args.teacher_holdout,
            "inSample": {"accuracy": teacher_accuracy, "n": teacher_n},
            "heldOut": {
                "accuracy": json_number(teacher_held_accuracy),
                "ci": [json_number(held_low), json_number(held_high)],
                "n": teacher_held_n,
            },
            "zeroShotValAccuracy": zero_shot,
        }
    prior_params: dict[str, np.ndarray] | None = prior if args.teacher else None

    print(f"\nsweeping L2 on the validation split ({args.dims} dims, head={args.head})")
    if prior_params is not None:
        print("  (L2 now pulls towards the teacher's parameters, not towards zero)")
    best = (None, -1.0, 0.0, 0)
    for l2 in (0.001, 0.01, 0.03, 0.1, 0.3, 1.0, 3.0, 10.0):
        params, seed = fit_best_of_seeds(
            x_train_l, x_train_r, y_train, l2,
            head=args.head, hidden=args.hidden, activation=args.activation,
            prior=prior_params, seeds=args.seeds,
            select_left=x_val_l, select_right=x_val_r, select_y=y_val,
        )
        scorer = make_scorer(params, args.head, args.activation)
        train_accuracy, _ = accuracy(x_train_l, x_train_r, y_train, scorer)
        val_accuracy, val_n = accuracy(x_val_l, x_val_r, y_val, scorer)
        print(f"  l2={l2:<7} train={train_accuracy:.3f}  val={val_accuracy:.3f}  (n={val_n})")
        if val_accuracy > best[1]:
            best = (params, val_accuracy, l2, seed)

    params, val_accuracy, l2, seed = best
    print(f"\nbest: l2={l2}, val={val_accuracy:.3f}")
    if args.head == "mlp":
        print(f"  best seed: {seed}")
    print("A coin flip scores 0.500. Treat anything inside the interval as unproven.")

    test_report = None
    if args.report_test:
        x_test_l, x_test_r, y_test = build_pairs(by_split["test"], reduced)
        scorer = make_scorer(params, args.head, args.activation)
        test_accuracy, test_n = accuracy(x_test_l, x_test_r, y_test, scorer)
        low, high = wilson_interval(test_accuracy, test_n)
        print(f"\nTEST: {test_accuracy:.3f}  95% CI [{low:.3f}, {high:.3f}]  (n={test_n})")
        test_report = {
            "accuracy": json_number(test_accuracy),
            "ci": [json_number(low), json_number(high)],
            "n": test_n,
        }
    else:
        print("\nTest split untouched. Pass --report-test once the design is frozen.")

    diagnostic = None
    if args.head == "mlp":
        pool_z = np.stack(list(reduced.values()))
        compare_score = None
        if args.compare_linear_artifact:
            compare_scorer_by_id = load_scorer(args.compare_linear_artifact, embeddings)
            pool_stems = list(reduced.keys())

            def compare_score(_z: np.ndarray, _stems: list[str] = pool_stems) -> np.ndarray:
                # collapse_diagnostic scores by array position, but the linear
                # artifact's loader scores by image id — reassemble in the same
                # order pool_z (and therefore `_z`) was built in.
                return np.array([compare_scorer_by_id(s) for s in _stems])

        diagnostic = collapse_diagnostic(params, args.activation, pool_z, compare_score)
        print(
            f"\ncollapse diagnostic ({args.activation}, hidden={args.hidden}, "
            f"n={diagnostic['nImages']} pool images):"
        )
        print(
            f"  |pre-activation|: mean={diagnostic['meanAbsPreActivation']:.3f}  "
            f"max={diagnostic['maxAbsPreActivation']:.3f}"
        )
        print(
            f"  fraction of score std NOT explained by a straight line through z: "
            f"{diagnostic['nonlinearStdFraction']:.3f}"
        )
        if "corrWithLinear" in diagnostic:
            print(f"  corr(mlp, linear) over the pool: {diagnostic['corrWithLinear']:.4f}")
            if diagnostic["collapsed"]:
                print(
                    "  COLLAPSED: correlation with the linear model exceeds 0.99. "
                    "This config computed an approximately linear function — its "
                    "accuracy numbers above are not evidence about a non-linear "
                    "function class, only about this particular (collapsed) fit."
                )
        else:
            print("  (no --compare-linear-artifact given; corr(mlp, linear) not computed)")

    # Display calibration. The head is trained on the sign of a difference, so a
    # raw margin has no scale of its own, but the live path has to show 0-100.
    # Storing the score distribution over the training images lets the service
    # map a new score to its rank without re-deriving anything, and keeps that
    # mapping attached to the weights it belongs to — swap the artifact and the
    # calibration swaps with it, which is what makes a head change drop-in.
    # Train split only: val and test images do not inform anything the product shows.
    print()
    calibration_scorer = make_scorer(params, args.head, args.activation)
    calibration_images = sorted(i for i, split in splits.items() if split == "train")
    train_scores = np.sort(
        np.asarray(calibration_scorer(np.stack([reduced[i] for i in calibration_images])))
    )
    calibration = np.interp(
        np.linspace(0.0, 1.0, CALIBRATION_QUANTILES),
        np.linspace(0.0, 1.0, train_scores.size),
        train_scores,
    ).astype(np.float32)
    print(
        ""
        f"calibration: {train_scores.size} train images -> "
        f"{CALIBRATION_QUANTILES} quantiles, "
        f"raw range [{train_scores[0]:.3f}, {train_scores[-1]:.3f}]"
    )

    args.artifact_dir.mkdir(parents=True, exist_ok=True)
    artifact = args.artifact_dir / "ranker.npz"
    if args.head == "linear":
        np.savez(
            artifact,
            centre=centre, basis=basis, weights=params["weights"],
            calibration=calibration,
        )
    else:
        np.savez(
            artifact,
            centre=centre, basis=basis,
            w1=params["w1"], b1=params["b1"], w2=params["w2"],
            activation=np.array(args.activation),
            calibration=calibration,
        )
    (args.artifact_dir / "ranker.json").write_text(
        json.dumps(
            {
                "version": RANKER_VERSIONS[args.head],
                "encoder": ENCODER,
                "head": args.head,
                "hidden": args.hidden if args.head == "mlp" else None,
                "activation": args.activation if args.head == "mlp" else None,
                "collapseDiagnostic": diagnostic,
                "dims": args.dims,
                "l2": l2,
                "trainPairs": counts["train"],
                "valAccuracy": val_accuracy,
                "test": test_report,
                "raters": sorted({c.rater for c in comparisons}),
                "ratersRequested": sorted(selected) if selected else "all",
                "teacherPairs": len(teacher) if teacher else 0,
                "teacher": teacher_report,
                "calibration": {
                    "quantiles": CALIBRATION_QUANTILES,
                    "fittedOnImages": len(calibration_images),
                    "rawRange": [float(train_scores[0]), float(train_scores[-1])],
                },
                "projectionFittedOn": (
                    f"{args.projection}-pool" if args.teacher else "train-images"
                ),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    try:
        location = artifact.relative_to(REPO_ROOT)
    except ValueError:
        location = artifact
    print(f"saved {location}")


if __name__ == "__main__":
    main()
