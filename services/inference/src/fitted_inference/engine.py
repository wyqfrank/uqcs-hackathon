from dataclasses import dataclass

from .config import Settings
from .schemas import ComparisonResponse


class ModelNotReadyError(RuntimeError):
    """Raised when comparison is requested before a model is configured."""


@dataclass(slots=True)
class InferenceEngine:
    """Stable service boundary for the future model implementation."""

    model_version: str = "unconfigured"
    ready: bool = False

    async def compare(self, player_a: bytes, player_b: bytes) -> ComparisonResponse:
        del player_a, player_b
        raise ModelNotReadyError(
            "No inference model is configured. Set FITTED_MODEL_PATH and provide an engine."
        )


def create_engine(settings: Settings) -> InferenceEngine:
    # Loading belongs here so a production engine is created once at startup,
    # rather than once per request. The scaffold stays explicitly unready until
    # the evaluated model implementation is connected.
    del settings
    return InferenceEngine()
