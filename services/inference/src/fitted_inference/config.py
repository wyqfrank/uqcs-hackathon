import os
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True, slots=True)
class Settings:
    environment: str
    model_path: str | None
    cors_origins: tuple[str, ...]
    max_image_bytes: int


@lru_cache
def get_settings() -> Settings:
    origins = os.getenv("FITTED_CORS_ORIGINS", "http://localhost:3000")
    return Settings(
        environment=os.getenv("FITTED_ENV", "development"),
        model_path=os.getenv("FITTED_MODEL_PATH"),
        cors_origins=tuple(origin.strip() for origin in origins.split(",") if origin.strip()),
        max_image_bytes=int(os.getenv("FITTED_MAX_IMAGE_BYTES", str(5 * 1024 * 1024))),
    )
