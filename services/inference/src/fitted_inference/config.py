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
    garment_backend: str | None
    garment_checkpoint_path: str | None
    garment_model_id: str | None
    garment_box_threshold: float
    garment_text_threshold: float
    garment_device: str | None
    garment_local_files_only: bool
    ranker_enabled: bool
    ranker_artifact_dir: str
    ranker_device: str | None
    ranker_display_min: float
    ranker_display_max: float
    cors_origins: tuple[str, ...]
    max_image_bytes: int
    max_burst_bytes: int


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
        vlm_prompt_version=os.getenv("FITTED_VLM_PROMPT_VERSION", "v2"),
        garment_backend=os.getenv("FITTED_GARMENT_BACKEND") or None,
        garment_checkpoint_path=os.getenv("FITTED_GARMENT_CHECKPOINT_PATH") or None,
        garment_model_id=os.getenv("FITTED_GARMENT_MODEL_ID") or None,
        garment_box_threshold=float(os.getenv("FITTED_GARMENT_BOX_THRESHOLD", "0.50")),
        garment_text_threshold=float(os.getenv("FITTED_GARMENT_TEXT_THRESHOLD", "0.25")),
        garment_device=os.getenv("FITTED_GARMENT_DEVICE") or None,
        garment_local_files_only=os.getenv(
            "FITTED_GARMENT_LOCAL_FILES_ONLY", "false"
        ).lower()
        in {"1", "true", "yes"},
        ranker_enabled=os.getenv("FITTED_RANKER_ENABLED", "true").lower()
        in {"1", "true", "yes"},
        ranker_artifact_dir=os.getenv("FITTED_RANKER_ARTIFACT_DIR", "models/ranker"),
        ranker_device=os.getenv("FITTED_RANKER_DEVICE") or None,
        # The live estimate has always occupied a band rather than the full
        # 0-100: a percentile mapped straight onto 0-100 puts the median outfit
        # on 50 and the worst on 0, which reads as an insult rather than a
        # score. The band is product policy, so it lives here; the distribution
        # it maps from is model policy and lives in the artifact.
        ranker_display_min=float(os.getenv("FITTED_RANKER_DISPLAY_MIN", "55")),
        ranker_display_max=float(os.getenv("FITTED_RANKER_DISPLAY_MAX", "85")),
        cors_origins=tuple(origin.strip() for origin in origins.split(",") if origin.strip()),
        max_image_bytes=int(os.getenv("FITTED_MAX_IMAGE_BYTES", str(5 * 1024 * 1024))),
        max_burst_bytes=int(
            os.getenv("FITTED_MAX_BURST_BYTES", str(15 * 1024 * 1024))
        ),
    )
