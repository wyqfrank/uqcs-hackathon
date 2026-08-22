from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class HealthResponse(ApiModel):
    status: Literal["ok"] = "ok"
    service: str = "fitted-inference"
    model_ready: bool
    model_version: str


GarmentCategory = Literal[
    "top",
    "bottoms",
    "dress",
    "outerwear",
    "shoes",
    "bag",
    "headwear",
    "accessory",
]


class NormalizedBox(ApiModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    width: float = Field(gt=0, le=1)
    height: float = Field(gt=0, le=1)


class GarmentDetection(ApiModel):
    category: GarmentCategory
    matched_prompt: str
    confidence: float = Field(ge=0, le=1)
    box: NormalizedBox


class GarmentCategoryResult(ApiModel):
    category: GarmentCategory
    state: Literal["detected", "not_detected", "not_present"]
    detections: list[GarmentDetection]


class GarmentPerceptionResponse(ApiModel):
    model_version: str
    categories: list[GarmentCategoryResult]
    latency_ms: int = Field(ge=0)


class GarmentHealthResponse(ApiModel):
    ready: bool
    model_version: str


class GarmentPairResponse(ApiModel):
    battle_id: str
    pair_id: str
    player_a_sample_id: str
    player_b_sample_id: str
    player_a_captured_at_ms: float
    player_b_captured_at_ms: float
    player_a: GarmentPerceptionResponse
    player_b: GarmentPerceptionResponse


class PlayerBreakdown(ApiModel):
    component_quality: float
    outfit_coordination: float
    body_fit: float
    vlm_holistic: float | None = None
    observations: list[str] = Field(default_factory=list)


class Breakdown(ApiModel):
    player_a: PlayerBreakdown
    player_b: PlayerBreakdown


class FrameQuality(ApiModel):
    player_a: Literal["ok", "poor", "unusable"]
    player_b: Literal["ok", "poor", "unusable"]


class ComparisonIdentity(ApiModel):
    battle_id: str
    finalisation_id: str
    pair_id: str
    player_a_sample_id: str
    player_b_sample_id: str
    player_a_captured_at_ms: float
    player_b_captured_at_ms: float


class FinalComparisonResponse(ComparisonIdentity):
    phase: Literal["final"] = "final"
    model_version: str
    prompt_version: str
    scoring_version: str
    player_a_score: float
    player_b_score: float
    winner: Literal["player_a", "player_b", "draw"]
    win_probability: float | None = None
    breakdown: Breakdown
    frame_quality: FrameQuality
    explanation: str
    latency_ms: int


NotScoreableReason = Literal[
    "unusable_image",
    "cannot_judge",
    "provider_refusal",
    "provider_invalid_response",
]


class NotScoreableResponse(ComparisonIdentity):
    phase: Literal["not_scoreable"] = "not_scoreable"
    intended_phase: Literal["final"] = "final"
    reason_code: NotScoreableReason
    message: str
    retryable: bool
    model_version: str
    prompt_version: str
    latency_ms: int


ComparisonResponse = Annotated[
    FinalComparisonResponse | NotScoreableResponse,
    Field(discriminator="phase"),
]
