from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from .config import get_settings
from .engine import (
    ComparisonContext,
    ComparisonImage,
    InferenceEngine,
    InferenceTimeoutError,
    InferenceUnavailableError,
    InvalidComparisonImageError,
    ModelNotReadyError,
    create_engine,
)
from .perception import (
    GarmentDetector,
    GarmentInferenceError,
    GarmentModelNotReadyError,
    InvalidGarmentImageError,
    create_garment_detector,
)
from .schemas import (
    ComparisonResponse,
    GarmentHealthResponse,
    GarmentPairResponse,
    GarmentPerceptionResponse,
    HealthResponse,
)

SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.engine = create_engine(settings)
    app.state.garment_detector = create_garment_detector(settings)
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


def get_garment_detector(request: Request) -> GarmentDetector:
    return request.app.state.garment_detector


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


@app.get("/v1/garments/health", response_model=GarmentHealthResponse)
async def garment_health(request: Request) -> GarmentHealthResponse:
    detector = get_garment_detector(request)
    return GarmentHealthResponse(ready=detector.ready, model_version=detector.model_version)


@app.post("/v1/garments", response_model=GarmentPerceptionResponse)
async def detect_garments(
    request: Request,
    image: Annotated[UploadFile, File(description="Canonical outfit crop")],
) -> GarmentPerceptionResponse:
    contents = await read_image(image)
    try:
        return await run_in_threadpool(get_garment_detector(request).detect, contents)
    except GarmentModelNotReadyError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except InvalidGarmentImageError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.post("/v1/garments/pair", response_model=GarmentPairResponse)
async def detect_garment_pair(
    request: Request,
    battle_id: Annotated[str, Form(min_length=1, max_length=64)],
    pair_id: Annotated[str, Form(min_length=1, max_length=128)],
    player_a_sample_id: Annotated[str, Form(min_length=1, max_length=128)],
    player_b_sample_id: Annotated[str, Form(min_length=1, max_length=128)],
    player_a_captured_at_ms: Annotated[float, Form(ge=0)],
    player_b_captured_at_ms: Annotated[float, Form(ge=0)],
    player_a: Annotated[UploadFile, File(description="Latest garment frame for player A")],
    player_b: Annotated[UploadFile, File(description="Latest garment frame for player B")],
) -> GarmentPairResponse:
    images = await read_image(player_a), await read_image(player_b)
    try:
        results = await run_in_threadpool(
            get_garment_detector(request).detect_many,
            images,
        )
    except GarmentModelNotReadyError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except InvalidGarmentImageError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except GarmentInferenceError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if len(results) != 2:
        raise HTTPException(status_code=503, detail="Garment detector returned an invalid batch.")
    return GarmentPairResponse(
        battle_id=battle_id,
        pair_id=pair_id,
        player_a_sample_id=player_a_sample_id,
        player_b_sample_id=player_b_sample_id,
        player_a_captured_at_ms=player_a_captured_at_ms,
        player_b_captured_at_ms=player_b_captured_at_ms,
        player_a=results[0],
        player_b=results[1],
    )


@app.post("/v1/compare", response_model=ComparisonResponse)
async def compare(
    request: Request,
    battle_id: Annotated[str, Form(min_length=1, max_length=64)],
    finalisation_id: Annotated[str, Form(min_length=1, max_length=128)],
    pair_id: Annotated[str, Form(min_length=1, max_length=128)],
    player_a_sample_id: Annotated[str, Form(min_length=1, max_length=128)],
    player_b_sample_id: Annotated[str, Form(min_length=1, max_length=128)],
    player_a_captured_at_ms: Annotated[float, Form(ge=0)],
    player_b_captured_at_ms: Annotated[float, Form(ge=0)],
    player_a: Annotated[UploadFile, File(description="Latest frame for player A")],
    player_b: Annotated[UploadFile, File(description="Latest frame for player B")],
) -> ComparisonResponse:
    images = await read_image(player_a), await read_image(player_b)
    context = ComparisonContext(
        battle_id=battle_id,
        finalisation_id=finalisation_id,
        pair_id=pair_id,
        player_a_sample_id=player_a_sample_id,
        player_b_sample_id=player_b_sample_id,
        player_a_captured_at_ms=player_a_captured_at_ms,
        player_b_captured_at_ms=player_b_captured_at_ms,
    )
    try:
        return await get_engine(request).compare(
            context,
            ComparisonImage(images[0], player_a.content_type or ""),
            ComparisonImage(images[1], player_b.content_type or ""),
        )
    except ModelNotReadyError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except InvalidComparisonImageError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except InferenceTimeoutError as error:
        raise HTTPException(status_code=504, detail=str(error)) from error
    except InferenceUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
