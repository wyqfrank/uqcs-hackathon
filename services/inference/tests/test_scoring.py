import json
import math

import pytest

from fitted_inference.scoring import (
    InvalidScoringModelError,
    PairwiseScoringHead,
    artifact_dict,
    create_visual_baseline_head,
    visual_fit_score,
)


def test_visual_fit_score_uses_documented_weights() -> None:
    assert visual_fit_score(
        component_quality=80,
        outfit_coordination=70,
        body_fit=60,
    ) == pytest.approx(72)


def test_visual_fit_score_rejects_out_of_range_inputs() -> None:
    with pytest.raises(InvalidScoringModelError, match="component_quality"):
        visual_fit_score(component_quality=101, outfit_coordination=70, body_fit=60)


def test_pairwise_comparison_is_swap_symmetric() -> None:
    head = create_visual_baseline_head(temperature=8)
    player_a = {"component_quality": 85, "outfit_coordination": 75, "body_fit": 80}
    player_b = {"component_quality": 60, "outfit_coordination": 70, "body_fit": 65}

    forward = head.compare(player_a, player_b)
    swapped = head.compare(player_b, player_a)

    assert forward.player_a_score == pytest.approx(swapped.player_b_score)
    assert forward.player_b_score == pytest.approx(swapped.player_a_score)
    assert forward.player_a_win_probability == pytest.approx(
        1 - swapped.player_a_win_probability
    )


def test_identical_feature_vectors_are_an_even_pair() -> None:
    head = create_visual_baseline_head()
    features = {"component_quality": 70, "outfit_coordination": 75, "body_fit": 80}

    prediction = head.compare(features, features)

    assert prediction.player_a_score == pytest.approx(prediction.player_b_score)
    assert prediction.player_a_win_probability == pytest.approx(0.5)


def test_scoring_requires_the_artifacts_exact_feature_contract() -> None:
    head = create_visual_baseline_head()

    with pytest.raises(InvalidScoringModelError, match="missing: body_fit"):
        head.score({"component_quality": 70, "outfit_coordination": 75})


def test_artifact_round_trip(tmp_path) -> None:
    original = create_visual_baseline_head(model_version="test-v3", temperature=7.5)
    path = tmp_path / "scoring.json"
    path.write_text(json.dumps(artifact_dict(original)), encoding="utf-8")

    loaded = PairwiseScoringHead.from_json_file(path)

    assert loaded == original


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("schemaVersion", 2, "schemaVersion"),
        ("weights", [0.45, -0.3, 0.85], "non-negative"),
        ("weights", [0.4, 0.3, 0.2], "sum to 1"),
        ("temperature", 0, "greater than zero"),
        ("temperature", math.inf, "finite"),
    ],
)
def test_invalid_artifacts_are_rejected(field, value, message) -> None:
    artifact = artifact_dict(create_visual_baseline_head())
    artifact[field] = value

    with pytest.raises(InvalidScoringModelError, match=message):
        PairwiseScoringHead.from_dict(artifact)
