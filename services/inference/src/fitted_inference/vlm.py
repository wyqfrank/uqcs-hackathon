"""Provider-neutral paired-image VLM assessment contract."""

from __future__ import annotations

import base64
from typing import Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

VLM_PROMPTS = {"v1": """You are the final outfit-comparison assessor for FITTED.
Judge only visible clothing and styling. Assess both labelled players with the same rubric.

Score these dimensions from 0 to 100:
- component_quality: visible quality and intentional styling of the clothing pieces.
- outfit_coordination: colour, silhouette, layering, proportion, material, and coherence.
- body_fit: how the garments visibly sit and align, without judging the person's body.
- vlm_holistic: an overall outfit judgement for diagnostics only.

Do not assess faces, attractiveness, body type, perceived gender, wealth, brand prestige,
popularity, or background. Use image quality only to decide whether clothing can be judged.
Never invent hidden garment details. Keep observations short and grounded in visible clothing.
Use cannot_judge if either outfit cannot be assessed fairly. Do not include hidden reasoning.
"""}


class VlmPlayerAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    frame_quality: Literal["ok", "poor", "unusable"]
    component_quality: float | None = Field(default=None, ge=0, le=100)
    outfit_coordination: float | None = Field(default=None, ge=0, le=100)
    body_fit: float | None = Field(default=None, ge=0, le=100)
    vlm_holistic: float | None = Field(default=None, ge=0, le=100)
    observations: list[str] = Field(default_factory=list, max_length=4)

    @model_validator(mode="after")
    def validate_scores_for_quality(self) -> VlmPlayerAssessment:
        scores = (
            self.component_quality,
            self.outfit_coordination,
            self.body_fit,
            self.vlm_holistic,
        )
        if self.frame_quality == "unusable" and any(score is not None for score in scores):
            raise ValueError("Unusable imagery must not contain numeric scores.")
        if self.frame_quality != "unusable" and any(score is None for score in scores):
            raise ValueError("Judgeable imagery must contain every numeric score.")
        if any(len(item.strip()) == 0 or len(item) > 180 for item in self.observations):
            raise ValueError("Observations must be non-empty and at most 180 characters.")
        return self


class VlmPairAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    preference: Literal["player_a", "player_b", "draw", "cannot_judge"]
    explanation: str = Field(min_length=1, max_length=500)


class VlmAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    player_a: VlmPlayerAssessment
    player_b: VlmPlayerAssessment
    pair: VlmPairAssessment


class VlmProviderError(RuntimeError):
    """Base error for provider failures."""


class VlmProviderRetryableError(VlmProviderError):
    """A transient provider failure that a final request may retry once."""


class VlmProviderTimeoutError(VlmProviderError):
    """The provider did not complete within the configured deadline."""


class VlmProviderRefusalError(VlmProviderError):
    """The provider refused or returned no assessable output."""


class VlmProviderInvalidResponseError(VlmProviderError):
    """The provider output did not satisfy the strict assessment schema."""


class VlmProvider(Protocol):
    model_version: str

    async def assess(
        self,
        *,
        player_a: bytes,
        player_a_mime_type: str,
        player_b: bytes,
        player_b_mime_type: str,
    ) -> VlmAssessment: ...


class GeminiVlmProvider:
    """Gemini Interactions API adapter with labelled inline images."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        prompt: str,
        media_resolution: str,
        timeout_seconds: float,
    ) -> None:
        try:
            from google import genai
        except ImportError as error:
            raise RuntimeError(
                "Gemini scoring requires the inference package's 'vlm' extra."
            ) from error

        # The application owns the retry budget. Disable SDK-level retries so a
        # transient failure results in at most one application retry.
        self._client = genai.Client(
            api_key=api_key,
            http_options={"retry_options": {"attempts": 1}},
        )
        self.model_version = model
        self._prompt = prompt
        self._media_resolution = media_resolution
        self._timeout_seconds = timeout_seconds

    async def assess(
        self,
        *,
        player_a: bytes,
        player_a_mime_type: str,
        player_b: bytes,
        player_b_mime_type: str,
    ) -> VlmAssessment:
        try:
            interaction = await self._client.aio.interactions.create(
                model=self.model_version,
                system_instruction=self._prompt,
                input=[
                    {"type": "text", "text": "Player A"},
                    {
                        "type": "image",
                        "data": base64.b64encode(player_a).decode("ascii"),
                        "mime_type": player_a_mime_type,
                        "resolution": self._media_resolution,
                    },
                    {"type": "text", "text": "Player B"},
                    {
                        "type": "image",
                        "data": base64.b64encode(player_b).decode("ascii"),
                        "mime_type": player_b_mime_type,
                        "resolution": self._media_resolution,
                    },
                    {"type": "text", "text": "Assess this labelled pair using the rubric."},
                ],
                response_format={
                    "type": "text",
                    "mime_type": "application/json",
                    "schema": VlmAssessment.model_json_schema(),
                },
                store=False,
                timeout=self._timeout_seconds,
            )
        except TimeoutError as error:
            raise VlmProviderTimeoutError("Gemini request timed out.") from error
        except Exception as error:
            status_code = getattr(error, "status_code", None) or getattr(error, "code", None)
            if status_code in {429, 500, 502, 503, 504}:
                raise VlmProviderRetryableError("Gemini is temporarily unavailable.") from error
            if status_code == 408 or "timeout" in type(error).__name__.lower():
                raise VlmProviderTimeoutError("Gemini request timed out.") from error
            raise VlmProviderError("Gemini request failed.") from error

        output_text = getattr(interaction, "output_text", None)
        if not output_text:
            raise VlmProviderRefusalError("Gemini returned no assessment.")
        try:
            return VlmAssessment.model_validate_json(output_text)
        except ValidationError as error:
            raise VlmProviderInvalidResponseError(
                "Gemini returned an invalid assessment."
            ) from error
