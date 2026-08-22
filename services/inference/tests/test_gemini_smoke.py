"""Opt-in real-provider smoke test using two explicitly consented local images."""

import os
from pathlib import Path

import pytest

from fitted_inference.config import get_settings
from fitted_inference.engine import ComparisonContext, ComparisonImage, create_engine

RUN_SMOKE = os.getenv("FITTED_RUN_GEMINI_SMOKE") == "1"
PLAYER_A_PATH = os.getenv("FITTED_SMOKE_PLAYER_A_PATH")
PLAYER_B_PATH = os.getenv("FITTED_SMOKE_PLAYER_B_PATH")


@pytest.mark.skipif(
    not (
        RUN_SMOKE
        and PLAYER_A_PATH
        and PLAYER_B_PATH
        and os.getenv("GEMINI_API_KEY")
        and os.getenv("FITTED_SCORING_BACKEND") == "vlm_fallback"
    ),
    reason="Real Gemini smoke test is opt-in and requires a key plus two consented images.",
)
@pytest.mark.anyio
async def test_real_gemini_pair() -> None:
    player_a_path = Path(PLAYER_A_PATH or "")
    player_b_path = Path(PLAYER_B_PATH or "")
    assert player_a_path.is_file() and player_b_path.is_file()

    engine = create_engine(get_settings())
    assert engine.ready
    context = ComparisonContext(
        battle_id="FITTED-SMOKE",
        finalisation_id="smoke-final",
        pair_id="smoke-pair",
        player_a_sample_id="smoke-a",
        player_b_sample_id="smoke-b",
        player_a_captured_at_ms=0,
        player_b_captured_at_ms=0,
    )
    mime_by_suffix = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
    player_a = ComparisonImage(
        player_a_path.read_bytes(), mime_by_suffix[player_a_path.suffix.lower()]
    )
    player_b = ComparisonImage(
        player_b_path.read_bytes(), mime_by_suffix[player_b_path.suffix.lower()]
    )

    result = await engine.compare(context, player_a, player_b)

    assert result.phase in {"final", "not_scoreable"}
