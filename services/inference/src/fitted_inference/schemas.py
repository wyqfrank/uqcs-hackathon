from typing import Literal

from pydantic import BaseModel, ConfigDict


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


class PlayerBreakdown(ApiModel):
    component_quality: float
    outfit_coordination: float
    body_fit: float


class Breakdown(ApiModel):
    player_a: PlayerBreakdown
    player_b: PlayerBreakdown


class FrameQuality(ApiModel):
    player_a: Literal["ok", "poor", "unusable"]
    player_b: Literal["ok", "poor", "unusable"]


class ComparisonResponse(ApiModel):
    model_version: str
    player_a_score: float
    player_b_score: float
    winner: Literal["player_a", "player_b", "draw"]
    win_probability: float | None = None
    breakdown: Breakdown
    frame_quality: FrameQuality
    latency_ms: int
