#!/usr/bin/env python
"""Load a ranker artifact and expose a pointwise `score(image) -> float`.

Owns the centre -> project -> L2-normalise math in one place. Before this
module existed, `benchmark_judges.py` reimplemented that projection inline
and `train_ranker.py` implemented it again for training — two copies that
would silently drift the moment the projection convention changed. Both now
delegate here.

Dispatches on which parameter keys the artifact's `.npz` contains: `weights`
means a linear head, `w1`/`b1`/`w2` means an MLP head (see train_ranker.py's
`fit_head` for how each is fitted).
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import numpy as np

ACTIVATIONS = ("tanh", "relu", "gelu")


def numpy_activation(name: str) -> Callable[[np.ndarray], np.ndarray]:
    """Numpy implementation of a hidden activation, by name.

    Single source of truth for both training-time scoring (train_ranker.py's
    `make_scorer`, `collapse_diagnostic`) and artifact inference (`load_scorer`
    below) — both call this rather than each defining their own, so the two
    paths can never silently drift apart the way the old inlined projection
    math did.
    """
    if name == "tanh":
        return np.tanh
    if name == "relu":
        return lambda x: np.maximum(x, 0.0)
    if name == "gelu":

        def gelu(x: np.ndarray) -> np.ndarray:
            return 0.5 * x * (1.0 + np.tanh(np.sqrt(2.0 / np.pi) * (x + 0.044715 * x**3)))

        return gelu
    raise ValueError(f"unknown activation {name!r}, expected one of {ACTIVATIONS}")


def project(vector: np.ndarray, centre: np.ndarray, basis: np.ndarray) -> np.ndarray:
    """Centre, project, and L2-normalise a single embedding.

    Mirrors `train_ranker.project`, which operates on a batch; kept as a
    single-vector version here because the artifact's consumers score one
    image at a time.
    """
    reduced = (vector - centre) @ basis.T
    norm = np.linalg.norm(reduced)
    return reduced / max(norm, 1e-8)


def load_scorer(
    artifact_dir: Path, embeddings: dict[str, np.ndarray]
) -> Callable[[str], float]:
    """Build `score(image_id) -> float` from a ranker artifact.

    `embeddings` maps image id to its raw (pre-projection) DINOv2 vector, e.g.
    the dict loaded from embeddings.npz — the same cache train_ranker.py
    writes and reads.
    """
    art = np.load(artifact_dir / "ranker.npz")
    centre, basis = art["centre"], art["basis"]

    if "weights" in art.files:
        weights = art["weights"]

        def score(stem: str) -> float:
            z = project(embeddings[stem], centre, basis)
            return float(z @ weights)

    elif "w1" in art.files:
        w1, b1, w2 = art["w1"], art["b1"], art["w2"]
        # Older mlp artifacts (before --activation existed) were always tanh.
        activation = str(art["activation"]) if "activation" in art.files else "tanh"
        act = numpy_activation(activation)

        def score(stem: str) -> float:
            z = project(embeddings[stem], centre, basis)
            return float(act(z @ w1.T + b1) @ w2)

    else:
        raise ValueError(
            f"{artifact_dir / 'ranker.npz'} has neither a 'weights' key (linear) "
            "nor 'w1'/'b1'/'w2' keys (mlp). Was it written by train_ranker.py?"
        )

    return score
