import base64
import io
from types import SimpleNamespace

import pytest
from PIL import Image
from pydantic import ValidationError

from fitted_inference.engine import (
    ComparisonContext,
    ComparisonImage,
    InferenceEngine,
    InferenceTimeoutError,
    InferenceUnavailableError,
    InvalidComparisonImageError,
)
from fitted_inference.vlm import (
    VLM_PROMPTS,
    GeminiVlmProvider,
    VlmAssessment,
    VlmPairAssessment,
    VlmPlayerAssessment,
    VlmProviderInvalidResponseError,
    VlmProviderRefusalError,
    VlmProviderRetryableError,
    VlmProviderTimeoutError,
)


def image_bytes() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (32, 64), "navy").save(output, format="WEBP")
    return output.getvalue()


def context() -> ComparisonContext:
    return ComparisonContext(
        battle_id="FIT-1234",
        finalisation_id="final-1",
        pair_id="pair-1",
        player_a_sample_id="sample-a",
        player_b_sample_id="sample-b",
        player_a_captured_at_ms=1000,
        player_b_captured_at_ms=1005,
    )


def assessment(*, unusable: bool = False, cannot_judge: bool = False) -> VlmAssessment:
    player_a = VlmPlayerAssessment(
        frame_quality="unusable" if unusable else "ok",
        component_quality=None if unusable else 80,
        outfit_coordination=None if unusable else 70,
        body_fit=None if unusable else 60,
        vlm_holistic=None if unusable else 99,
        observations=[] if unusable else ["Layering is visibly coordinated."],
    )
    return VlmAssessment(
        player_a=player_a,
        player_b=VlmPlayerAssessment(
            frame_quality="ok",
            component_quality=60,
            outfit_coordination=60,
            body_fit=60,
            vlm_holistic=1,
            observations=["The pieces use a consistent palette."],
        ),
        pair=VlmPairAssessment(
            preference="cannot_judge" if cannot_judge else "player_a",
            explanation="Player A has the stronger visible outfit coordination.",
        ),
    )


class FakeProvider:
    model_version = "fake-vlm"

    def __init__(self, result: VlmAssessment) -> None:
        self.result = result
        self.calls = 0
        self.last_kwargs = None

    async def assess(self, **kwargs) -> VlmAssessment:
        assert all(mime_type == "image/webp" for _, mime_type in kwargs["player_a_images"])
        assert all(mime_type == "image/webp" for _, mime_type in kwargs["player_b_images"])
        self.calls += 1
        self.last_kwargs = kwargs
        return self.result


@pytest.mark.anyio
async def test_engine_builds_deterministic_final_score_without_holistic_double_counting() -> None:
    provider = FakeProvider(assessment())
    engine = InferenceEngine(provider=provider, prompt_version="prompt-v1")
    image = ComparisonImage(image_bytes(), "image/webp")

    result = await engine.compare(context(), image, image)

    assert result.phase == "final"
    assert result.player_a_score == pytest.approx(72)
    assert result.player_b_score == pytest.approx(60)
    assert result.winner == "player_a"
    assert result.win_probability is None
    assert result.breakdown.player_a.vlm_holistic == 99
    assert result.model_version == "fake-vlm"
    assert result.finalisation_id == "final-1"
    assert result.sample_pairs[0].player_a_sample_id == "sample-a"


@pytest.mark.anyio
async def test_engine_sends_five_chronological_pairs_in_one_provider_call() -> None:
    provider = FakeProvider(assessment())
    engine = InferenceEngine(provider=provider)
    images = [ComparisonImage(image_bytes(), "image/webp") for _ in range(5)]

    result = await engine.compare(context(), images, images)

    assert result.phase == "final"
    assert provider.calls == 1
    assert len(provider.last_kwargs["player_a_images"]) == 5
    assert len(provider.last_kwargs["player_b_images"]) == 5


@pytest.mark.anyio
async def test_engine_rejects_unpaired_or_oversized_bursts_before_provider() -> None:
    provider = FakeProvider(assessment())
    engine = InferenceEngine(provider=provider)
    image = ComparisonImage(image_bytes(), "image/webp")

    with pytest.raises(InvalidComparisonImageError, match="one to five paired"):
        await engine.compare(context(), [image, image], [image])
    with pytest.raises(InvalidComparisonImageError, match="one to five paired"):
        await engine.compare(context(), [image] * 6, [image] * 6)

    assert provider.calls == 0


@pytest.mark.anyio
async def test_engine_returns_not_scoreable_for_unusable_player() -> None:
    engine = InferenceEngine(provider=FakeProvider(assessment(unusable=True)))
    image = ComparisonImage(image_bytes(), "image/webp")

    result = await engine.compare(context(), image, image)

    assert result.phase == "not_scoreable"
    assert result.reason_code == "unusable_image"
    assert result.retryable is True


@pytest.mark.anyio
async def test_engine_returns_not_scoreable_for_cannot_judge() -> None:
    engine = InferenceEngine(provider=FakeProvider(assessment(cannot_judge=True)))
    image = ComparisonImage(image_bytes(), "image/webp")

    result = await engine.compare(context(), image, image)

    assert result.phase == "not_scoreable"
    assert result.reason_code == "cannot_judge"


@pytest.mark.anyio
async def test_engine_retries_one_transient_provider_failure() -> None:
    class RetryProvider(FakeProvider):
        async def assess(self, **kwargs) -> VlmAssessment:
            self.calls += 1
            if self.calls == 1:
                raise VlmProviderRetryableError("busy")
            return self.result

    provider = RetryProvider(assessment())
    engine = InferenceEngine(provider=provider)
    image = ComparisonImage(image_bytes(), "image/webp")

    result = await engine.compare(context(), image, image)

    assert result.phase == "final"
    assert provider.calls == 2


@pytest.mark.anyio
async def test_engine_stops_after_second_transient_provider_failure() -> None:
    class RetryProvider(FakeProvider):
        async def assess(self, **kwargs) -> VlmAssessment:
            self.calls += 1
            raise VlmProviderRetryableError("busy")

    provider = RetryProvider(assessment())
    engine = InferenceEngine(provider=provider)
    image = ComparisonImage(image_bytes(), "image/webp")

    with pytest.raises(InferenceUnavailableError):
        await engine.compare(context(), image, image)

    assert provider.calls == 2


@pytest.mark.anyio
async def test_engine_does_not_retry_timeout() -> None:
    class TimeoutProvider(FakeProvider):
        async def assess(self, **kwargs) -> VlmAssessment:
            self.calls += 1
            raise VlmProviderTimeoutError("timeout")

    provider = TimeoutProvider(assessment())
    engine = InferenceEngine(provider=provider)
    image = ComparisonImage(image_bytes(), "image/webp")

    with pytest.raises(InferenceTimeoutError):
        await engine.compare(context(), image, image)

    assert provider.calls == 1


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("provider_error", "reason_code"),
    [
        (VlmProviderRefusalError("refused"), "provider_refusal"),
        (VlmProviderInvalidResponseError("invalid"), "provider_invalid_response"),
    ],
)
async def test_engine_does_not_retry_semantic_provider_failures(
    provider_error: Exception,
    reason_code: str,
) -> None:
    class SemanticFailureProvider(FakeProvider):
        async def assess(self, **kwargs) -> VlmAssessment:
            self.calls += 1
            raise provider_error

    provider = SemanticFailureProvider(assessment())
    engine = InferenceEngine(provider=provider)
    image = ComparisonImage(image_bytes(), "image/webp")

    result = await engine.compare(context(), image, image)

    assert result.phase == "not_scoreable"
    assert result.reason_code == reason_code
    assert provider.calls == 1


@pytest.mark.anyio
async def test_engine_rejects_undecodable_image_before_provider() -> None:
    provider = FakeProvider(assessment())
    engine = InferenceEngine(provider=provider)

    with pytest.raises(InvalidComparisonImageError):
        await engine.compare(
            context(),
            ComparisonImage(b"not-an-image", "image/webp"),
            ComparisonImage(image_bytes(), "image/webp"),
        )

    assert provider.calls == 0


@pytest.mark.anyio
async def test_engine_rejects_mime_mismatch_before_provider() -> None:
    provider = FakeProvider(assessment())
    engine = InferenceEngine(provider=provider)

    with pytest.raises(InvalidComparisonImageError, match="MIME type"):
        await engine.compare(
            context(),
            ComparisonImage(image_bytes(), "image/jpeg"),
            ComparisonImage(image_bytes(), "image/webp"),
        )

    assert provider.calls == 0


@pytest.mark.anyio
async def test_final_scores_and_winner_are_swap_invariant() -> None:
    original = assessment()
    swapped = VlmAssessment(
        player_a=original.player_b,
        player_b=original.player_a,
        pair=VlmPairAssessment(
            preference="player_b",
            explanation="Player B has the stronger visible outfit coordination.",
        ),
    )
    image = ComparisonImage(image_bytes(), "image/webp")

    forward = await InferenceEngine(provider=FakeProvider(original)).compare(
        context(), image, image
    )
    reverse = await InferenceEngine(provider=FakeProvider(swapped)).compare(
        context(), image, image
    )

    assert forward.phase == "final"
    assert reverse.phase == "final"
    assert forward.player_a_score == pytest.approx(reverse.player_b_score)
    assert forward.player_b_score == pytest.approx(reverse.player_a_score)
    assert forward.winner == "player_a"
    assert reverse.winner == "player_b"


@pytest.mark.anyio
async def test_final_scores_inside_two_points_are_a_draw() -> None:
    close_pair = assessment()
    close_pair.player_b.component_quality = 77
    close_pair.player_b.outfit_coordination = 70
    close_pair.player_b.body_fit = 60
    engine = InferenceEngine(provider=FakeProvider(close_pair))
    image = ComparisonImage(image_bytes(), "image/webp")

    result = await engine.compare(context(), image, image)

    assert result.phase == "final"
    assert abs(result.player_a_score - result.player_b_score) < 2
    assert result.winner == "draw"


def test_vlm_schema_rejects_scores_for_unusable_image() -> None:
    with pytest.raises(ValidationError, match="Unusable imagery"):
        VlmPlayerAssessment(
            frame_quality="unusable",
            component_quality=50,
            outfit_coordination=None,
            body_fit=None,
            vlm_holistic=None,
        )


@pytest.mark.anyio
async def test_gemini_adapter_labels_inline_images_and_requests_strict_schema() -> None:
    calls = []

    class FakeInteractions:
        async def create(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(output_text=assessment().model_dump_json())

    provider = GeminiVlmProvider.__new__(GeminiVlmProvider)
    provider._client = SimpleNamespace(aio=SimpleNamespace(interactions=FakeInteractions()))
    provider.model_version = "gemini-3.6-flash"
    provider._prompt = VLM_PROMPTS["v1"]
    provider._media_resolution = "high"
    provider._timeout_seconds = 12

    result = await provider.assess(
        player_a_images=[(b"image-a-1", "image/webp"), (b"image-a-2", "image/jpeg")],
        player_b_images=[(b"image-b-1", "image/jpeg"), (b"image-b-2", "image/webp")],
    )

    assert result.pair.preference == "player_a"
    request = calls[0]
    assert request["input"][0] == {
        "type": "text",
        "text": "Player A chronological sequence (2 image(s))",
    }
    assert base64.b64decode(request["input"][1]["data"]) == b"image-a-1"
    assert base64.b64decode(request["input"][2]["data"]) == b"image-a-2"
    assert request["input"][1]["resolution"] == "high"
    assert request["input"][3] == {
        "type": "text",
        "text": "Player B chronological sequence (2 image(s))",
    }
    assert base64.b64decode(request["input"][4]["data"]) == b"image-b-1"
    assert base64.b64decode(request["input"][5]["data"]) == b"image-b-2"
    assert request["response_format"]["mime_type"] == "application/json"
    assert request["store"] is False
    assert "faces" in request["system_instruction"]
