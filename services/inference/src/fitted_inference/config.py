import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True, slots=True)
class Settings:
    environment: str
    model_path: str | None
    scoring_backend: str | None
    gemini_api_key: str | None
    vlm_model: str
    vlm_media_resolution: str
    vlm_timeout_seconds: float
    vlm_prompt_version: str
    garment_model_id: str | None
    garment_box_threshold: float
    garment_text_threshold: float
    garment_device: str | None
    garment_local_files_only: bool
    cors_origins: tuple[str, ...]
    max_image_bytes: int


@lru_cache
def get_settings() -> Settings:
    origins = os.getenv("FITTED_CORS_ORIGINS", "http://localhost:3000")
    return Settings(
        environment=os.getenv("FITTED_ENV", "development"),
        model_path=os.getenv("FITTED_MODEL_PATH"),
        scoring_backend=os.getenv("FITTED_SCORING_BACKEND") or None,
        gemini_api_key=os.getenv("GEMINI_API_KEY") or None,
        vlm_model=os.getenv("FITTED_VLM_MODEL", "gemini-3.6-flash"),
        vlm_media_resolution=os.getenv("FITTED_VLM_MEDIA_RESOLUTION", "high"),
        vlm_timeout_seconds=float(os.getenv("FITTED_VLM_TIMEOUT_SECONDS", "12")),
        vlm_prompt_version=os.getenv("FITTED_VLM_PROMPT_VERSION", "v1"),
        garment_model_id=os.getenv("FITTED_GARMENT_MODEL_ID") or None,
        garment_box_threshold=float(os.getenv("FITTED_GARMENT_BOX_THRESHOLD", "0.35")),
        garment_text_threshold=float(os.getenv("FITTED_GARMENT_TEXT_THRESHOLD", "0.25")),
        garment_device=os.getenv("FITTED_GARMENT_DEVICE") or None,
        garment_local_files_only=os.getenv(
            "FITTED_GARMENT_LOCAL_FILES_ONLY", "false"
        ).lower()
        in {"1", "true", "yes"},
        cors_origins=tuple(origin.strip() for origin in origins.split(",") if origin.strip()),
        max_image_bytes=int(os.getenv("FITTED_MAX_IMAGE_BYTES", str(5 * 1024 * 1024))),
    )
