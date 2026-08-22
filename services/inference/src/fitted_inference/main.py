from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .engine import InferenceEngine, ModelNotReadyError, create_engine
from .schemas import ComparisonResponse, HealthResponse

SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.engine = create_engine(settings)
    yield


app = FastAPI(
    title="FITTED Inference API",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(settings.cors_origins),
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def get_engine(request: Request) -> InferenceEngine:
    return request.app.state.engine


async def read_image(upload: UploadFile) -> bytes:
    if upload.content_type not in SUPPORTED_IMAGE_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Images must be JPEG, PNG, or WebP.",
        )

    contents = await upload.read(settings.max_image_bytes + 1)
    if not contents:
        raise HTTPException(status_code=422, detail="Image is empty.")
    if len(contents) > settings.max_image_bytes:
        raise HTTPException(status_code=413, detail="Image exceeds the configured size limit.")
    return contents


@app.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    engine = get_engine(request)
    return HealthResponse(model_ready=engine.ready, model_version=engine.model_version)


@app.post("/v1/compare", response_model=ComparisonResponse)
async def compare(
    request: Request,
    player_a: Annotated[UploadFile, File(description="Latest frame for player A")],
    player_b: Annotated[UploadFile, File(description="Latest frame for player B")],
) -> ComparisonResponse:
    images = await read_image(player_a), await read_image(player_b)
    try:
        return await get_engine(request).compare(*images)
    except ModelNotReadyError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
