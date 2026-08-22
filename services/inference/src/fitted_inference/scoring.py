"""Deterministic score composition and pairwise calibration primitives.

This module deliberately contains no training or encoder dependencies. Offline
training emits the small JSON artifact consumed by :class:`PairwiseScoringHead`.
"""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Historical superset of feature names. The Instagram, Depop, and momentum
# source experts are out of scope for the hackathon; the shipped baseline head
# uses the three visual features only (see `create_visual_baseline_head`).
# Retained for reference; this constant is currently unreferenced.
DEFAULT_FEATURE_NAMES = (
    "instagram",  # out of scope: hackathon
    "depop",  # out of scope: hackathon
    "momentum",  # out of scope: hackathon
    "component_quality",
    "outfit_coordination",
    "body_fit",
    "vlm_holistic",
)
ARTIFACT_SCHEMA_VERSION = 1


class InvalidScoringModelError(ValueError):
    """Raised when a scoring artifact or score vector violates its contract."""


def _validate_score(value: float, name: str) -> float:
    score = float(value)
    if not math.isfinite(score) or not 0 <= score <= 100:
        raise InvalidScoringModelError(f"{name} must be a finite score from 0 to 100.")
    return score


def visual_fit_score(
    *,
    component_quality: float,
    outfit_coordination: float,
    body_fit: float,
) -> float:
    """Apply the prototype's documented 45/30/25 visual weighting."""

    component = _validate_score(component_quality, "component_quality")
    coordination = _validate_score(outfit_coordination, "outfit_coordination")
    fit = _validate_score(body_fit, "body_fit")
    return 0.45 * component + 0.30 * coordination + 0.25 * fit


@dataclass(frozen=True, slots=True)
class PairwisePrediction:
    player_a_score: float
    player_b_score: float
    player_a_win_probability: float


@dataclass(frozen=True, slots=True)
class PairwiseScoringHead:
    """A non-negative linear scorer with a logistic pairwise calibration."""

    model_version: str
    feature_names: tuple[str, ...]
    weights: tuple[float, ...]
    temperature: float

    def __post_init__(self) -> None:
        if not self.model_version.strip():
            raise InvalidScoringModelError("model_version must not be empty.")
        if not self.feature_names:
            raise InvalidScoringModelError("At least one scoring feature is required.")
        if len(set(self.feature_names)) != len(self.feature_names):
            raise InvalidScoringModelError("feature_names must be unique.")
        if len(self.feature_names) != len(self.weights):
            raise InvalidScoringModelError("Each feature must have exactly one weight.")
        if any(not name.strip() for name in self.feature_names):
            raise InvalidScoringModelError("Feature names must not be empty.")
        if any(not math.isfinite(weight) or weight < 0 for weight in self.weights):
            raise InvalidScoringModelError("Feature weights must be finite and non-negative.")
        if not math.isclose(sum(self.weights), 1.0, rel_tol=1e-6, abs_tol=1e-6):
            raise InvalidScoringModelError("Feature weights must sum to 1.")
        if not math.isfinite(self.temperature) or self.temperature <= 0:
            raise InvalidScoringModelError("temperature must be finite and greater than zero.")

    @classmethod
    def from_dict(cls, artifact: Mapping[str, Any]) -> PairwiseScoringHead:
        if artifact.get("schemaVersion") != ARTIFACT_SCHEMA_VERSION:
            raise InvalidScoringModelError(
                f"schemaVersion must be {ARTIFACT_SCHEMA_VERSION}."
            )

        feature_names = artifact.get("featureNames")
        weights = artifact.get("weights")
        if (
            not isinstance(feature_names, list)
            or not all(isinstance(name, str) for name in feature_names)
        ):
            raise InvalidScoringModelError("featureNames must be a list of strings.")
        if not isinstance(weights, list) or not all(
            isinstance(weight, (int, float)) and not isinstance(weight, bool)
            for weight in weights
        ):
            raise InvalidScoringModelError("weights must be a list of numbers.")

        model_version = artifact.get("modelVersion")
        temperature = artifact.get("temperature")
        if not isinstance(model_version, str):
            raise InvalidScoringModelError("modelVersion must be a string.")
        if not isinstance(temperature, (int, float)) or isinstance(temperature, bool):
            raise InvalidScoringModelError("temperature must be a number.")

        return cls(
            model_version=model_version,
            feature_names=tuple(feature_names),
            weights=tuple(float(weight) for weight in weights),
            temperature=float(temperature),
        )

    @classmethod
    def from_json_file(cls, path: str | Path) -> PairwiseScoringHead:
        try:
            artifact = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise InvalidScoringModelError(f"Could not read scoring artifact: {error}") from error
        if not isinstance(artifact, dict):
            raise InvalidScoringModelError("Scoring artifact must contain a JSON object.")
        return cls.from_dict(artifact)

    def score(self, features: Mapping[str, float]) -> float:
        expected = set(self.feature_names)
        received = set(features)
        if received != expected:
            missing = sorted(expected - received)
            unexpected = sorted(received - expected)
            details = []
            if missing:
                details.append(f"missing: {', '.join(missing)}")
            if unexpected:
                details.append(f"unexpected: {', '.join(unexpected)}")
            raise InvalidScoringModelError("Feature mismatch (" + "; ".join(details) + ").")

        values = (
            _validate_score(features[name], name)
            for name in self.feature_names
        )
        return sum(weight * value for weight, value in zip(self.weights, values, strict=True))

    def compare(
        self,
        player_a: Mapping[str, float],
        player_b: Mapping[str, float],
    ) -> PairwisePrediction:
        player_a_score = self.score(player_a)
        player_b_score = self.score(player_b)
        logit = (player_a_score - player_b_score) / self.temperature

        # This form remains stable for very large positive or negative logits.
        if logit >= 0:
            exp_negated = math.exp(-logit)
            probability = 1 / (1 + exp_negated)
        else:
            exp_logit = math.exp(logit)
            probability = exp_logit / (1 + exp_logit)

        return PairwisePrediction(
            player_a_score=player_a_score,
            player_b_score=player_b_score,
            player_a_win_probability=probability,
        )


def create_visual_baseline_head(
    *, model_version: str = "visual-baseline-v1", temperature: float = 10.0
) -> PairwiseScoringHead:
    """Create the documented pre-calibration baseline over visual signals only."""

    return PairwiseScoringHead(
        model_version=model_version,
        feature_names=("component_quality", "outfit_coordination", "body_fit"),
        weights=(0.45, 0.30, 0.25),
        temperature=temperature,
    )


def artifact_dict(head: PairwiseScoringHead) -> dict[str, Any]:
    """Return the stable JSON-serialisable representation used by offline training."""

    return {
        "schemaVersion": ARTIFACT_SCHEMA_VERSION,
        "modelVersion": head.model_version,
        "featureNames": list(head.feature_names),
        "weights": list(head.weights),
        "temperature": head.temperature,
    }
