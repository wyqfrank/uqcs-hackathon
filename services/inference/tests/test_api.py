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
    VlmProviderError,
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


def test_garment_pair_batches_players_in_authoritative_order(monkeypatch) -> None:
    calls = []

    class FakeGarmentDetector:
        ready = True
        model_version = "fake-fashionpedia"

        def detect_many(self, images):
            calls.append(images)
            return [
                build_garment_response(
                    [RawGarmentDetection("shirt", 0.9, (0, 0, 32, 32))],
                    32,
                    64,
                    self.model_version,
                    5,
                ),
                build_garment_response(
                    [RawGarmentDetection("pants", 0.8, (0, 32, 32, 64))],
                    32,
                    64,
                    self.model_version,
                    5,
                ),
            ]

    monkeypatch.setattr(
        main_module,
        "create_garment_detector",
        lambda _settings: FakeGarmentDetector(),
    )
    player_a = valid_image_bytes()
    player_b = valid_image_bytes()
    data = {
        "battle_id": "FIT-1234",
        "pair_id": "garment-pair-1",
        "player_a_sample_id": "sample-a",
        "player_b_sample_id": "sample-b",
        "player_a_captured_at_ms": "1000",
        "player_b_captured_at_ms": "1005",
    }
    files = {
        "player_a": ("player-a.webp", player_a, "image/webp"),
        "player_b": ("player-b.webp", player_b, "image/webp"),
    }

    with TestClient(app) as client:
        response = client.post("/v1/garments/pair", data=data, files=files)

    assert response.status_code == 200
    assert calls == [(player_a, player_b)]
    payload = response.json()
    assert payload["battleId"] == "FIT-1234"
    assert payload["pairId"] == "garment-pair-1"
    assert payload["playerA"]["categories"][0]["category"] == "top"
    assert payload["playerB"]["categories"][1]["category"] == "bottoms"


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


def test_compare_accepts_three_chronological_pairs_in_one_request(monkeypatch) -> None:
    calls = []

    class FakeProvider:
        model_version = "fake-vlm"

        async def assess(self, **kwargs) -> VlmAssessment:
            calls.append(kwargs)
            return VlmAssessment(
                player_a=VlmPlayerAssessment(
                    frame_quality="ok",
                    component_quality=80,
                    outfit_coordination=70,
                    body_fit=60,
                    vlm_holistic=75,
                ),
                player_b=VlmPlayerAssessment(
                    frame_quality="ok",
                    component_quality=60,
                    outfit_coordination=60,
                    body_fit=60,
                    vlm_holistic=60,
                ),
                pair=VlmPairAssessment(
                    preference="player_a",
                    explanation="Player A is more coordinated across the sequence.",
                ),
            )

    monkeypatch.setattr(
        main_module,
        "create_engine",
        lambda _settings: InferenceEngine(provider=FakeProvider(), prompt_version="prompt-v2"),
    )
    image = valid_image_bytes()
    data = {
        "battle_id": "FIT-1234",
        "finalisation_id": "final-1",
        "pair_id": "burst-1",
        "player_a_sample_id": ["a-0", "a-1", "a-2"],
        "player_b_sample_id": ["b-0", "b-1", "b-2"],
        "player_a_captured_at_ms": ["1000", "1750", "2500"],
        "player_b_captured_at_ms": ["1005", "1755", "2505"],
    }
    files = [
        *(('player_a', (f"a-{index}.webp", image, "image/webp")) for index in range(3)),
        *(('player_b', (f"b-{index}.webp", image, "image/webp")) for index in range(3)),
    ]

    with TestClient(app) as client:
        response = client.post("/v1/compare", data=data, files=files)

    assert response.status_code == 200
    payload = response.json()
    assert len(calls) == 1
    assert len(calls[0]["player_a_images"]) == 3
    assert payload["playerASampleId"] == "a-2"
    assert payload["playerBSampleId"] == "b-2"
    assert [pair["burstIndex"] for pair in payload["samplePairs"]] == [0, 1, 2]


def test_compare_rejects_mismatched_or_non_chronological_burst() -> None:
    image = valid_image_bytes()
    mismatched = {
        **COMPARISON_FORM,
        "player_a_sample_id": ["a-0", "a-1"],
    }
    files = {
        "player_a": ("player-a.webp", image, "image/webp"),
        "player_b": ("player-b.webp", image, "image/webp"),
    }
    with TestClient(app) as client:
        mismatch_response = client.post("/v1/compare", data=mismatched, files=files)
        chronological_response = client.post(
            "/v1/compare",
            data={
                **COMPARISON_FORM,
                "player_a_sample_id": ["a-0", "a-1"],
                "player_b_sample_id": ["b-0", "b-1"],
                "player_a_captured_at_ms": ["2000", "1000"],
                "player_b_captured_at_ms": ["1000", "2000"],
            },
            files=[
                ("player_a", ("a-0.webp", image, "image/webp")),
                ("player_a", ("a-1.webp", image, "image/webp")),
                ("player_b", ("b-0.webp", image, "image/webp")),
                ("player_b", ("b-1.webp", image, "image/webp")),
            ],
        )

    assert mismatch_response.status_code == 422
    assert "equal lengths" in mismatch_response.json()["detail"]
    assert chronological_response.status_code == 422
    assert "chronological" in chronological_response.json()["detail"]


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


def test_compare_maps_provider_failure_to_service_unavailable(monkeypatch) -> None:
    class FailedProvider:
        model_version = "fake-vlm"

        async def assess(self, **_kwargs):
            raise VlmProviderError("provider failed")

    monkeypatch.setattr(
        main_module,
        "create_engine",
        lambda _settings: InferenceEngine(provider=FailedProvider()),
    )
    image = valid_image_bytes()
    files = {
        "player_a": ("player-a.webp", image, "image/webp"),
        "player_b": ("player-b.webp", image, "image/webp"),
    }

    with TestClient(app) as client:
        response = client.post("/v1/compare", data=COMPARISON_FORM, files=files)

    assert response.status_code == 503
    assert response.json()["detail"] == "provider failed"


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
