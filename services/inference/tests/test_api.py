import io

from fastapi.testclient import TestClient
from PIL import Image

import fitted_inference.main as main_module
from fitted_inference.engine import InferenceEngine
from fitted_inference.main import app
from fitted_inference.perception import RawGarmentDetection, build_garment_response
from fitted_inference.vlm import (
    VlmAssessment,
    VlmPairAssessment,
    VlmPlayerAssessment,
    VlmProviderTimeoutError,
)

COMPARISON_FORM = {
    "battle_id": "FIT-1234",
    "finalisation_id": "final-1",
    "pair_id": "pair-1",
    "player_a_sample_id": "sample-a",
    "player_b_sample_id": "sample-b",
    "player_a_captured_at_ms": "1000",
    "player_b_captured_at_ms": "1005",
}


def valid_image_bytes() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (32, 64), "navy").save(output, format="WEBP")
    return output.getvalue()


def test_health_reports_unconfigured_model() -> None:
    with TestClient(app) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "fitted-inference",
        "modelReady": False,
        "modelVersion": "unconfigured",
    }


def test_compare_is_explicitly_unavailable_without_model() -> None:
    files = {
        "player_a": ("player-a.webp", b"frame-a", "image/webp"),
        "player_b": ("player-b.webp", b"frame-b", "image/webp"),
    }

    with TestClient(app) as client:
        response = client.post("/v1/compare", data=COMPARISON_FORM, files=files)

    assert response.status_code == 503
    assert "No inference model is configured" in response.json()["detail"]


def test_compare_rejects_unsupported_media() -> None:
    files = {
        "player_a": ("player-a.txt", b"not an image", "text/plain"),
        "player_b": ("player-b.webp", b"frame-b", "image/webp"),
    }

    with TestClient(app) as client:
        response = client.post("/v1/compare", data=COMPARISON_FORM, files=files)

    assert response.status_code == 415


def test_compare_rejects_oversized_image() -> None:
    files = {
        "player_a": (
            "player-a.webp",
            b"x" * (main_module.settings.max_image_bytes + 1),
            "image/webp",
        ),
        "player_b": ("player-b.webp", valid_image_bytes(), "image/webp"),
    }

    with TestClient(app) as client:
        response = client.post("/v1/compare", data=COMPARISON_FORM, files=files)

    assert response.status_code == 413


def test_compare_returns_typed_final_result_with_identity(monkeypatch) -> None:
    class FakeProvider:
        model_version = "fake-vlm"

        async def assess(self, **_kwargs) -> VlmAssessment:
            return VlmAssessment(
                player_a=VlmPlayerAssessment(
                    frame_quality="ok",
                    component_quality=80,
                    outfit_coordination=70,
                    body_fit=60,
                    vlm_holistic=90,
                    observations=["Visible coordinated layering."],
                ),
                player_b=VlmPlayerAssessment(
                    frame_quality="ok",
                    component_quality=60,
                    outfit_coordination=60,
                    body_fit=60,
                    vlm_holistic=60,
                    observations=["Visible consistent palette."],
                ),
                pair=VlmPairAssessment(
                    preference="player_a",
                    explanation="Player A has stronger visible coordination.",
                ),
            )

    monkeypatch.setattr(
        main_module,
        "create_engine",
        lambda _settings: InferenceEngine(provider=FakeProvider(), prompt_version="prompt-v1"),
    )
    image = valid_image_bytes()
    files = {
        "player_a": ("player-a.webp", image, "image/webp"),
        "player_b": ("player-b.webp", image, "image/webp"),
    }

    with TestClient(app) as client:
        response = client.post("/v1/compare", data=COMPARISON_FORM, files=files)

    assert response.status_code == 200
    payload = response.json()
    assert payload["phase"] == "final"
    assert payload["battleId"] == "FIT-1234"
    assert payload["finalisationId"] == "final-1"
    assert payload["playerAScore"] == 72
    assert payload["breakdown"]["playerA"]["vlmHolistic"] == 90
    assert payload["winProbability"] is None


def test_compare_rejects_undecodable_supported_media(monkeypatch) -> None:
    class FakeProvider:
        model_version = "fake-vlm"

        async def assess(self, **_kwargs):
            raise AssertionError("Provider must not receive invalid images.")

    monkeypatch.setattr(
        main_module,
        "create_engine",
        lambda _settings: InferenceEngine(provider=FakeProvider()),
    )
    files = {
        "player_a": ("player-a.webp", b"not-an-image", "image/webp"),
        "player_b": ("player-b.webp", valid_image_bytes(), "image/webp"),
    }

    with TestClient(app) as client:
        response = client.post("/v1/compare", data=COMPARISON_FORM, files=files)

    assert response.status_code == 422
    assert response.json()["detail"] == "Image could not be decoded."


def test_compare_returns_typed_not_scoreable_result(monkeypatch) -> None:
    class CannotJudgeProvider:
        model_version = "fake-vlm"

        async def assess(self, **_kwargs) -> VlmAssessment:
            return VlmAssessment(
                player_a=VlmPlayerAssessment(
                    frame_quality="unusable",
                    observations=["The outfit is mostly outside the frame."],
                ),
                player_b=VlmPlayerAssessment(
                    frame_quality="ok",
                    component_quality=60,
                    outfit_coordination=60,
                    body_fit=60,
                    vlm_holistic=60,
                ),
                pair=VlmPairAssessment(
                    preference="cannot_judge",
                    explanation="Player A cannot be judged from this frame.",
                ),
            )

    monkeypatch.setattr(
        main_module,
        "create_engine",
        lambda _settings: InferenceEngine(provider=CannotJudgeProvider()),
    )
    image = valid_image_bytes()
    files = {
        "player_a": ("player-a.webp", image, "image/webp"),
        "player_b": ("player-b.webp", image, "image/webp"),
    }

    with TestClient(app) as client:
        response = client.post("/v1/compare", data=COMPARISON_FORM, files=files)

    assert response.status_code == 200
    assert response.json()["phase"] == "not_scoreable"
    assert response.json()["reasonCode"] == "unusable_image"


def test_compare_maps_provider_timeout_to_gateway_timeout(monkeypatch) -> None:
    class TimeoutProvider:
        model_version = "fake-vlm"

        async def assess(self, **_kwargs):
            raise VlmProviderTimeoutError("provider timed out")

    monkeypatch.setattr(
        main_module,
        "create_engine",
        lambda _settings: InferenceEngine(provider=TimeoutProvider()),
    )
    image = valid_image_bytes()
    files = {
        "player_a": ("player-a.webp", image, "image/webp"),
        "player_b": ("player-b.webp", image, "image/webp"),
    }

    with TestClient(app) as client:
        response = client.post("/v1/compare", data=COMPARISON_FORM, files=files)

    assert response.status_code == 504
    assert response.json()["detail"] == "provider timed out"


def test_garment_health_reports_unconfigured_model() -> None:
    with TestClient(app) as client:
        response = client.get("/v1/garments/health")

    assert response.status_code == 200
    assert response.json() == {"ready": False, "modelVersion": "unconfigured"}


def test_garment_detection_is_explicitly_unavailable_without_model() -> None:
    files = {"image": ("outfit.webp", b"frame", "image/webp")}

    with TestClient(app) as client:
        response = client.post("/v1/garments", files=files)

    assert response.status_code == 503
    assert "No garment model is configured" in response.json()["detail"]


def test_garment_endpoint_returns_typed_perception(monkeypatch) -> None:
    class FakeGarmentDetector:
        ready = True
        model_version = "fake-garment-model"

        def detect(self, image_bytes: bytes):
            assert image_bytes == b"frame"
            return build_garment_response(
                [RawGarmentDetection("dress", 0.9, (10, 10, 90, 190))],
                image_width=100,
                image_height=200,
                model_version=self.model_version,
                latency_ms=4,
            )

    monkeypatch.setattr(
        main_module,
        "create_garment_detector",
        lambda settings: FakeGarmentDetector(),
    )
    files = {"image": ("outfit.webp", b"frame", "image/webp")}

    with TestClient(app) as client:
        response = client.post("/v1/garments", files=files)

    assert response.status_code == 200
    payload = response.json()
    assert payload["modelVersion"] == "fake-garment-model"
    assert payload["categories"][2] == {
        "category": "dress",
        "state": "detected",
        "detections": [
            {
                "category": "dress",
                "matchedPrompt": "dress",
                "confidence": 0.9,
                "box": {"x": 0.1, "y": 0.05, "width": 0.8, "height": 0.9},
            }
        ],
    }
