from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from .config import get_settings
from .engine import (
    ComparisonContext,
    ComparisonImage,
    ComparisonSamplePair,
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


def validate_comparison_burst(
    player_a: list[UploadFile],
    player_b: list[UploadFile],
    player_a_sample_id: list[str],
    player_b_sample_id: list[str],
    player_a_captured_at_ms: list[float],
    player_b_captured_at_ms: list[float],
    burst_index: list[int] | None,
) -> tuple[int, list[int]]:
    lengths = {
        len(player_a),
        len(player_b),
        len(player_a_sample_id),
        len(player_b_sample_id),
        len(player_a_captured_at_ms),
        len(player_b_captured_at_ms),
    }
    if len(lengths) != 1:
        raise HTTPException(
            status_code=422,
            detail="Burst images, sample IDs, and capture timestamps must have equal lengths.",
        )
    count = lengths.pop()
    if not 1 <= count <= 3:
        raise HTTPException(
            status_code=422,
            detail="Comparison requires one to three paired images.",
        )
    indexes = burst_index if burst_index is not None else list(range(count))
    if (
        len(indexes) != count
        or any(index < 0 or index > 2 for index in indexes)
        or indexes != sorted(set(indexes))
    ):
        raise HTTPException(
            status_code=422,
            detail="Burst indexes must be unique, chronological values from zero to two.",
        )
    if any(not sample_id or len(sample_id) > 128 for sample_id in (
        *player_a_sample_id,
        *player_b_sample_id,
    )):
        raise HTTPException(status_code=422, detail="Sample IDs are invalid.")
    for timestamps in (player_a_captured_at_ms, player_b_captured_at_ms):
        if any(
            current < previous
            for previous, current in zip(timestamps, timestamps[1:], strict=False)
        ):
            raise HTTPException(
                status_code=422,
                detail="Burst capture timestamps must be chronological.",
            )
    return count, indexes


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
    player_a_sample_id: Annotated[list[str], Form()],
    player_b_sample_id: Annotated[list[str], Form()],
    player_a_captured_at_ms: Annotated[list[float], Form()],
    player_b_captured_at_ms: Annotated[list[float], Form()],
    player_a: Annotated[list[UploadFile], File(description="Chronological frames for player A")],
    player_b: Annotated[list[UploadFile], File(description="Chronological frames for player B")],
    burst_index: Annotated[list[int] | None, Form()] = None,
) -> ComparisonResponse:
    count, burst_indexes = validate_comparison_burst(
        player_a,
        player_b,
        player_a_sample_id,
        player_b_sample_id,
        player_a_captured_at_ms,
        player_b_captured_at_ms,
        burst_index,
    )
    player_a_bytes = [await read_image(upload) for upload in player_a]
    player_b_bytes = [await read_image(upload) for upload in player_b]
    if sum(map(len, (*player_a_bytes, *player_b_bytes))) > settings.max_burst_bytes:
        raise HTTPException(
            status_code=413,
            detail="Image burst exceeds the configured size limit.",
        )
    latest = count - 1
    sample_pairs = tuple(
        ComparisonSamplePair(
            burst_index=burst_indexes[index],
            player_a_sample_id=player_a_sample_id[index],
            player_b_sample_id=player_b_sample_id[index],
            player_a_captured_at_ms=player_a_captured_at_ms[index],
            player_b_captured_at_ms=player_b_captured_at_ms[index],
        )
        for index in range(count)
    )
    context = ComparisonContext(
        battle_id=battle_id,
        finalisation_id=finalisation_id,
        pair_id=pair_id,
        player_a_sample_id=player_a_sample_id[latest],
        player_b_sample_id=player_b_sample_id[latest],
        player_a_captured_at_ms=player_a_captured_at_ms[latest],
        player_b_captured_at_ms=player_b_captured_at_ms[latest],
        sample_pairs=sample_pairs,
    )
    try:
        return await get_engine(request).compare(
            context,
            [
                ComparisonImage(contents, upload.content_type or "")
                for contents, upload in zip(player_a_bytes, player_a, strict=True)
            ],
            [
                ComparisonImage(contents, upload.content_type or "")
                for contents, upload in zip(player_b_bytes, player_b, strict=True)
            ],
        )
    except ModelNotReadyError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except InvalidComparisonImageError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except InferenceTimeoutError as error:
        raise HTTPException(status_code=504, detail=str(error)) from error
    except InferenceUnavailableError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
