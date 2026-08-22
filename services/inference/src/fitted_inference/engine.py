"""Online paired-image scoring engine."""

from __future__ import annotations

import asyncio
import io
import time
from collections.abc import Sequence
from dataclasses import dataclass

from .config import Settings
from .schemas import (
    Breakdown,
    ComparisonResponse,
    FinalComparisonResponse,
    FrameQuality,
    NotScoreableResponse,
    PlayerBreakdown,
)
from .scoring import visual_fit_score
from .vlm import (
    VLM_PROMPTS,
    GeminiVlmProvider,
    VlmAssessment,
    VlmProvider,
    VlmProviderError,
    VlmProviderInvalidResponseError,
    VlmProviderRefusalError,
    VlmProviderRetryableError,
    VlmProviderTimeoutError,
)

MAX_IMAGE_PIXELS = 16_000_000
DRAW_THRESHOLD = 2.0
SCORING_VERSION = "visual-45-30-25-v1"


class ModelNotReadyError(RuntimeError):
    """Raised when comparison is requested before a model is configured."""


class InvalidComparisonImageError(ValueError):
    """Raised when uploaded bytes are not a safe, decodable image."""


class InferenceTimeoutError(RuntimeError):
    """Raised when the configured VLM times out after its final retry."""


class InferenceUnavailableError(RuntimeError):
    """Raised when the configured provider cannot complete the comparison."""


@dataclass(frozen=True, slots=True)
class ComparisonSamplePair:
    burst_index: int
    player_a_sample_id: str
    player_b_sample_id: str
    player_a_captured_at_ms: float
    player_b_captured_at_ms: float

    def response_fields(self) -> dict[str, str | float | int]:
        return {
            "burst_index": self.burst_index,
            "player_a_sample_id": self.player_a_sample_id,
            "player_b_sample_id": self.player_b_sample_id,
            "player_a_captured_at_ms": self.player_a_captured_at_ms,
            "player_b_captured_at_ms": self.player_b_captured_at_ms,
        }


@dataclass(frozen=True, slots=True)
class ComparisonContext:
    battle_id: str
    finalisation_id: str
    pair_id: str
    player_a_sample_id: str
    player_b_sample_id: str
    player_a_captured_at_ms: float
    player_b_captured_at_ms: float
    sample_pairs: tuple[ComparisonSamplePair, ...] = ()

    def response_fields(self) -> dict[str, object]:
        sample_pairs = self.sample_pairs or (
            ComparisonSamplePair(
                burst_index=0,
                player_a_sample_id=self.player_a_sample_id,
                player_b_sample_id=self.player_b_sample_id,
                player_a_captured_at_ms=self.player_a_captured_at_ms,
                player_b_captured_at_ms=self.player_b_captured_at_ms,
            ),
        )
        return {
            "battle_id": self.battle_id,
            "finalisation_id": self.finalisation_id,
            "pair_id": self.pair_id,
            "player_a_sample_id": self.player_a_sample_id,
            "player_b_sample_id": self.player_b_sample_id,
            "player_a_captured_at_ms": self.player_a_captured_at_ms,
            "player_b_captured_at_ms": self.player_b_captured_at_ms,
            "sample_pairs": [sample.response_fields() for sample in sample_pairs],
        }


@dataclass(frozen=True, slots=True)
class ComparisonImage:
    contents: bytes
    mime_type: str


def validate_comparison_image(image: ComparisonImage) -> None:
    try:
        from PIL import Image, UnidentifiedImageError
    except ImportError as error:
        raise ModelNotReadyError(
            "VLM scoring requires the inference package's 'vlm' extra."
        ) from error

    try:
        with Image.open(io.BytesIO(image.contents)) as decoded:
            actual_format = decoded.format
            decoded.verify()
        with Image.open(io.BytesIO(image.contents)) as decoded:
            width, height = decoded.size
    except (UnidentifiedImageError, OSError, ValueError) as error:
        raise InvalidComparisonImageError("Image could not be decoded.") from error
    if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
        raise InvalidComparisonImageError("Image dimensions exceed the configured limit.")
    expected_mime_type = {
        "JPEG": "image/jpeg",
        "PNG": "image/png",
        "WEBP": "image/webp",
    }.get(actual_format or "")
    if expected_mime_type != image.mime_type:
        raise InvalidComparisonImageError("Image MIME type does not match its content.")


def normalise_comparison_images(
    images: ComparisonImage | Sequence[ComparisonImage],
) -> tuple[ComparisonImage, ...]:
    if isinstance(images, ComparisonImage):
        return (images,)
    return tuple(images)


@dataclass(slots=True)
class InferenceEngine:
    provider: VlmProvider | None = None
    prompt_version: str = "v1"

    @property
    def ready(self) -> bool:
        return self.provider is not None

    @property
    def model_version(self) -> str:
        return self.provider.model_version if self.provider else "unconfigured"

    async def compare(
        self,
        context: ComparisonContext,
        player_a: ComparisonImage | Sequence[ComparisonImage],
        player_b: ComparisonImage | Sequence[ComparisonImage],
    ) -> ComparisonResponse:
        if not self.provider:
            raise ModelNotReadyError(
                "No inference model is configured. Set GEMINI_API_KEY and "
                "FITTED_SCORING_BACKEND=vlm_fallback."
            )

        player_a_images = normalise_comparison_images(player_a)
        player_b_images = normalise_comparison_images(player_b)
        if not 1 <= len(player_a_images) <= 3 or len(player_a_images) != len(player_b_images):
            raise InvalidComparisonImageError(
                "Comparison requires one to three paired images per player."
            )
        for image in (*player_a_images, *player_b_images):
            validate_comparison_image(image)
        started_at = time.perf_counter()
        try:
            assessment = await self._assess_with_retry(player_a_images, player_b_images)
        except VlmProviderRefusalError:
            return self._provider_not_scoreable(
                context,
                "provider_refusal",
                "The final assessor could not evaluate this pair. Retry with clearer framing.",
                started_at,
            )
        except VlmProviderInvalidResponseError:
            return self._provider_not_scoreable(
                context,
                "provider_invalid_response",
                "The final assessor returned an invalid result. Please retry.",
                started_at,
            )
        latency_ms = round((time.perf_counter() - started_at) * 1000)
        return self._build_response(context, assessment, latency_ms)

    async def _assess_with_retry(
        self,
        player_a: Sequence[ComparisonImage],
        player_b: Sequence[ComparisonImage],
    ) -> VlmAssessment:
        assert self.provider is not None
        for attempt in range(2):
            try:
                return await self.provider.assess(
                    player_a_images=[
                        (image.contents, image.mime_type) for image in player_a
                    ],
                    player_b_images=[
                        (image.contents, image.mime_type) for image in player_b
                    ],
                )
            except VlmProviderRetryableError as error:
                if attempt == 1:
                    raise InferenceUnavailableError(str(error)) from error
                await asyncio.sleep(0.25)
            except VlmProviderTimeoutError as error:
                raise InferenceTimeoutError(str(error)) from error
            except (VlmProviderRefusalError, VlmProviderInvalidResponseError):
                raise
            except VlmProviderError as error:
                raise InferenceUnavailableError(str(error)) from error
        raise AssertionError("Retry loop must return or raise.")

    def _provider_not_scoreable(
        self,
        context: ComparisonContext,
        reason_code: str,
        message: str,
        started_at: float,
    ) -> NotScoreableResponse:
        return NotScoreableResponse(
            **context.response_fields(),
            reason_code=reason_code,
            message=message,
            retryable=True,
            model_version=self.model_version,
            prompt_version=self.prompt_version,
            latency_ms=round((time.perf_counter() - started_at) * 1000),
        )

    def _build_response(
        self,
        context: ComparisonContext,
        assessment: VlmAssessment,
        latency_ms: int,
    ) -> ComparisonResponse:
        identity = context.response_fields()
        if (
            assessment.player_a.frame_quality == "unusable"
            or assessment.player_b.frame_quality == "unusable"
        ):
            return NotScoreableResponse(
                **identity,
                reason_code="unusable_image",
                message="One or both outfits were not visible enough to judge. Reframe and retry.",
                retryable=True,
                model_version=self.model_version,
                prompt_version=self.prompt_version,
                latency_ms=latency_ms,
            )
        if assessment.pair.preference == "cannot_judge":
            return NotScoreableResponse(
                **identity,
                reason_code="cannot_judge",
                message="The outfits could not be compared fairly. Reframe and retry.",
                retryable=True,
                model_version=self.model_version,
                prompt_version=self.prompt_version,
                latency_ms=latency_ms,
            )

        player_a = assessment.player_a
        player_b = assessment.player_b
        assert player_a.component_quality is not None
        assert player_a.outfit_coordination is not None
        assert player_a.body_fit is not None
        assert player_b.component_quality is not None
        assert player_b.outfit_coordination is not None
        assert player_b.body_fit is not None
        player_a_score = visual_fit_score(
            component_quality=player_a.component_quality,
            outfit_coordination=player_a.outfit_coordination,
            body_fit=player_a.body_fit,
        )
        player_b_score = visual_fit_score(
            component_quality=player_b.component_quality,
            outfit_coordination=player_b.outfit_coordination,
            body_fit=player_b.body_fit,
        )
        difference = player_a_score - player_b_score
        winner = (
            "draw"
            if abs(difference) < DRAW_THRESHOLD
            else "player_a" if difference > 0 else "player_b"
        )

        return FinalComparisonResponse(
            **identity,
            model_version=self.model_version,
            prompt_version=self.prompt_version,
            scoring_version=SCORING_VERSION,
            player_a_score=player_a_score,
            player_b_score=player_b_score,
            winner=winner,
            win_probability=None,
            breakdown=Breakdown(
                player_a=PlayerBreakdown(
                    component_quality=player_a.component_quality,
                    outfit_coordination=player_a.outfit_coordination,
                    body_fit=player_a.body_fit,
                    vlm_holistic=player_a.vlm_holistic,
                    observations=player_a.observations,
                ),
                player_b=PlayerBreakdown(
                    component_quality=player_b.component_quality,
                    outfit_coordination=player_b.outfit_coordination,
                    body_fit=player_b.body_fit,
                    vlm_holistic=player_b.vlm_holistic,
                    observations=player_b.observations,
                ),
            ),
            frame_quality=FrameQuality(
                player_a=player_a.frame_quality,
                player_b=player_b.frame_quality,
            ),
            explanation=assessment.pair.explanation,
            latency_ms=latency_ms,
        )


def create_engine(settings: Settings) -> InferenceEngine:
    prompt = VLM_PROMPTS.get(settings.vlm_prompt_version)
    if (
        settings.scoring_backend != "vlm_fallback"
        or not settings.gemini_api_key
        or prompt is None
    ):
        return InferenceEngine(prompt_version=settings.vlm_prompt_version)
    provider = GeminiVlmProvider(
        api_key=settings.gemini_api_key,
        model=settings.vlm_model,
        prompt=prompt,
        media_resolution=settings.vlm_media_resolution,
        timeout_seconds=settings.vlm_timeout_seconds,
    )
    return InferenceEngine(provider=provider, prompt_version=settings.vlm_prompt_version)
