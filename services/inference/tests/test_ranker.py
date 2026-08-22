import io

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from fitted_inference.config import Settings
from fitted_inference.main import app
from fitted_inference.ranker import (
    Dinov2FitRanker,
    InvalidRankerImageError,
    RankerModelNotReadyError,
    UnavailableFitRanker,
    _percentile_of,
    _resolve_artifact_dir,
    _to_tensor,
    create_fit_ranker,
)


def valid_image_bytes() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (32, 64), "navy").save(output, format="WEBP")
    return output.getvalue()


def settings(**overrides) -> Settings:
    base = dict(
        environment="test",
        model_path=None,
        scoring_backend=None,
        gemini_api_key=None,
        vlm_model="gemini-3.6-flash",
        vlm_media_resolution="high",
        vlm_timeout_seconds=12.0,
        vlm_prompt_version="v2",
        garment_backend=None,
        garment_checkpoint_path=None,
        garment_model_id=None,
        garment_box_threshold=0.5,
        garment_text_threshold=0.25,
        garment_device=None,
        garment_local_files_only=False,
        ranker_enabled=True,
        ranker_artifact_dir="models/ranker",
        ranker_device=None,
        ranker_display_min=55.0,
        ranker_display_max=85.0,
        cors_origins=("http://localhost:3000",),
        max_image_bytes=5 * 1024 * 1024,
        max_burst_bytes=15 * 1024 * 1024,
    )
    base.update(overrides)
    return Settings(**base)


# --------------------------------------------------------------------------
# Calibration
# --------------------------------------------------------------------------


def test_percentile_places_a_margin_in_the_distribution() -> None:
    calibration = np.array([-2.0, -1.0, 0.0, 1.0, 2.0])
    assert _percentile_of(-5.0, calibration) == 0.0
    assert _percentile_of(5.0, calibration) == 1.0
    assert _percentile_of(0.0, calibration) == pytest.approx(0.5)


def test_percentile_puts_ties_at_the_midpoint_of_their_run() -> None:
    # Three identical scores should share one percentile rather than the
    # lowest of the run, otherwise repeated frames of a still subject drift.
    calibration = np.array([0.0, 1.0, 1.0, 1.0, 2.0])
    assert _percentile_of(1.0, calibration) == pytest.approx(0.5)


def test_percentile_without_a_distribution_is_neutral() -> None:
    assert _percentile_of(3.0, np.zeros(0)) == 0.5


# --------------------------------------------------------------------------
# Preprocessing
# --------------------------------------------------------------------------


def test_preprocessing_letterboxes_to_a_square_224() -> None:
    tensor = _to_tensor(valid_image_bytes())
    assert tensor.shape == (3, 224, 224)


def test_preprocessing_preserves_aspect_ratio() -> None:
    """A wide image and a tall one of the same subject must not be stretched.

    The letterbox exists so a full-body photo keeps its shoes and head; a
    resize straight to 224x224 would distort proportion, which is part of what
    the model is being asked to judge.
    """
    wide = io.BytesIO()
    Image.new("RGB", (200, 100), "black").save(wide, format="WEBP")
    tensor = _to_tensor(wide.getvalue())
    # White padding fills the top and bottom bands; the middle is the subject.
    top_row = tensor[:, 0, :]
    middle_row = tensor[:, 112, :]
    assert top_row.mean() > middle_row.mean()


def test_undecodable_bytes_are_rejected() -> None:
    with pytest.raises(InvalidRankerImageError):
        _to_tensor(b"not an image")


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------


def test_disabled_ranker_reports_why() -> None:
    ranker = create_fit_ranker(settings(ranker_enabled=False))
    assert isinstance(ranker, UnavailableFitRanker)
    assert not ranker.ready
    assert "FITTED_RANKER_ENABLED" in ranker.reason


def test_missing_artifact_reports_why(tmp_path) -> None:
    ranker = create_fit_ranker(settings(ranker_artifact_dir=str(tmp_path)))
    assert isinstance(ranker, UnavailableFitRanker)
    assert "regenerated" in ranker.reason


def test_unavailable_ranker_refuses_to_score() -> None:
    ranker = create_fit_ranker(settings(ranker_enabled=False))
    with pytest.raises(RankerModelNotReadyError):
        ranker.score(valid_image_bytes())


def test_artifact_without_calibration_is_refused(tmp_path) -> None:
    """A raw margin has no scale, so an uncalibrated artifact cannot be shown.

    Failing loudly here is the point: silently inventing a display mapping
    would put a plausible-looking number on screen that means nothing.
    """
    np.savez(
        tmp_path / "ranker.npz",
        centre=np.zeros(384, dtype=np.float32),
        basis=np.zeros((16, 384), dtype=np.float32),
        weights=np.zeros(16, dtype=np.float32),
    )
    with pytest.raises(RankerModelNotReadyError, match="calibration"):
        Dinov2FitRanker(tmp_path, display_min=55.0, display_max=85.0)


def test_relative_artifact_dir_resolves_against_the_repository(tmp_path) -> None:
    """The service is launched from more than one working directory."""
    resolved = _resolve_artifact_dir("models/ranker")
    assert resolved.is_absolute()


# --------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------


def test_fit_score_health_is_served_when_the_model_is_absent(monkeypatch) -> None:
    monkeypatch.setattr(
        "fitted_inference.main.create_fit_ranker",
        lambda _settings: UnavailableFitRanker("no artifact in this test"),
    )
    with TestClient(app) as client:
        response = client.get("/v1/fit-score/health")

    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is False
    assert body["reason"] == "no artifact in this test"


def test_fit_score_returns_503_when_the_model_is_absent(monkeypatch) -> None:
    monkeypatch.setattr(
        "fitted_inference.main.create_fit_ranker",
        lambda _settings: UnavailableFitRanker("no artifact in this test"),
    )
    with TestClient(app) as client:
        response = client.post(
            "/v1/fit-score",
            files={"image": ("frame.webp", valid_image_bytes(), "image/webp")},
        )

    assert response.status_code == 503


def test_fit_score_rejects_an_unsupported_media_type(monkeypatch) -> None:
    monkeypatch.setattr(
        "fitted_inference.main.create_fit_ranker",
        lambda _settings: UnavailableFitRanker("no artifact in this test"),
    )
    with TestClient(app) as client:
        response = client.post(
            "/v1/fit-score",
            files={"image": ("frame.gif", b"GIF89a", "image/gif")},
        )

    assert response.status_code == 415
