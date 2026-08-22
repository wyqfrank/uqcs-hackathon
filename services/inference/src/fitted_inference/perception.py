from __future__ import annotations

import hashlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from importlib import import_module
from importlib.metadata import PackageNotFoundError, version
from inspect import signature
from io import BytesIO
from pathlib import Path
from time import perf_counter
from typing import Any, Protocol

from .config import Settings
from .fashionpedia import (
    FASHIONPEDIA_TOTAL_CLASS_COUNT,
    fashionpedia_category_for_name,
    normalize_fashionpedia_name,
    validate_fashionpedia_class_names,
)
from .schemas import (
    GarmentCategory,
    GarmentCategoryResult,
    GarmentDetection,
    GarmentPerceptionResponse,
    NormalizedBox,
)

RFDETR_PACKAGE_VERSION = "1.9.3"
RFDETR_CHECKPOINT_REVISION = "f1b64c11fa42d2f7455708b7a05f81c015461427"
RFDETR_CHECKPOINT_SHA256 = "aafefc440ea8f3f388e894a898e4270a2eeb6e38a3c3ffd3751d07d0f30b26bb"
RFDETR_DEFAULT_THRESHOLD = 0.50

CATEGORY_ORDER: tuple[GarmentCategory, ...] = (
    "top",
    "bottoms",
    "dress",
    "outerwear",
    "shoes",
    "bag",
    "headwear",
    "accessory",
)

PROMPTS: dict[GarmentCategory, tuple[str, ...]] = {
    "top": ("shirt", "sweater", "hoodie"),
    "bottoms": ("pants", "jeans", "shorts", "skirt"),
    "dress": ("dress", "jumpsuit"),
    "outerwear": ("jacket", "coat", "blazer"),
    "shoes": ("shoes",),
    "bag": ("bag",),
    "headwear": ("hat",),
    "accessory": ("scarf", "belt", "tie", "sunglasses"),
}

LABEL_TO_CATEGORY = {
    label: category for category, labels in PROMPTS.items() for label in labels
}
GROUNDING_DINO_PROMPT = " ".join(
    f"{label}." for category in CATEGORY_ORDER for label in PROMPTS[category]
)


class GarmentModelNotReadyError(RuntimeError):
    """Raised when garment perception is requested without a configured model."""


class InvalidGarmentCheckpointError(GarmentModelNotReadyError):
    """Raised when checkpoint provenance, structure, or taxonomy is invalid."""


class InvalidGarmentImageError(ValueError):
    """Raised when uploaded bytes cannot be decoded as an image."""


class GarmentInferenceError(RuntimeError):
    """Raised when a loaded detector violates its prediction contract."""


@dataclass(frozen=True, slots=True)
class RawGarmentDetection:
    label: str
    confidence: float
    box: tuple[float, float, float, float]


class GarmentDetector(Protocol):
    ready: bool
    model_version: str

    def detect(self, image_bytes: bytes) -> GarmentPerceptionResponse: ...

    def detect_many(self, images: Sequence[bytes]) -> list[GarmentPerceptionResponse]: ...


def grounding_dino_box_threshold_argument(processor: object) -> str:
    """Support the Transformers 4.x and 5.x post-processing APIs."""
    parameters = signature(processor.post_process_grounded_object_detection).parameters  # type: ignore[attr-defined]
    return "box_threshold" if "box_threshold" in parameters else "threshold"


@dataclass(frozen=True, slots=True)
class UnavailableGarmentDetector:
    model_version: str = "unconfigured"
    ready: bool = False

    def detect(self, image_bytes: bytes) -> GarmentPerceptionResponse:
        del image_bytes
        raise GarmentModelNotReadyError(
            "No garment model is configured. Configure Grounding DINO or RF-DETR."
        )

    def detect_many(self, images: Sequence[bytes]) -> list[GarmentPerceptionResponse]:
        del images
        raise GarmentModelNotReadyError(
            "No garment model is configured. Configure Grounding DINO or RF-DETR."
        )


def _normalise_label(label: str) -> str:
    return " ".join(label.strip().lower().rstrip(".").split())


def _category_for_label(label: str) -> GarmentCategory | None:
    normalised = _normalise_label(label)
    fashionpedia = fashionpedia_category_for_name(normalised)
    if fashionpedia:
        return fashionpedia
    direct = LABEL_TO_CATEGORY.get(normalised)
    if direct:
        return direct
    matched = {
        category
        for prompt, category in LABEL_TO_CATEGORY.items()
        if prompt in normalised.split()
    }
    return next(iter(matched)) if len(matched) == 1 else None


def _normalise_box(
    box: tuple[float, float, float, float],
    image_width: int,
    image_height: int,
) -> NormalizedBox | None:
    left, top, right, bottom = box
    left = min(float(image_width), max(0.0, left))
    top = min(float(image_height), max(0.0, top))
    right = min(float(image_width), max(0.0, right))
    bottom = min(float(image_height), max(0.0, bottom))
    if right <= left or bottom <= top:
        return None
    return NormalizedBox(
        x=left / image_width,
        y=top / image_height,
        width=(right - left) / image_width,
        height=(bottom - top) / image_height,
    )


def _intersection_over_union(left: NormalizedBox, right: NormalizedBox) -> float:
    intersection_left = max(left.x, right.x)
    intersection_top = max(left.y, right.y)
    intersection_right = min(left.x + left.width, right.x + right.width)
    intersection_bottom = min(left.y + left.height, right.y + right.height)
    intersection_width = max(0.0, intersection_right - intersection_left)
    intersection_height = max(0.0, intersection_bottom - intersection_top)
    intersection = intersection_width * intersection_height
    union = left.width * left.height + right.width * right.height - intersection
    return intersection / union if union > 0 else 0.0


def _covered_fraction(container: NormalizedBox, item: NormalizedBox) -> float:
    intersection_left = max(container.x, item.x)
    intersection_top = max(container.y, item.y)
    intersection_right = min(container.x + container.width, item.x + item.width)
    intersection_bottom = min(container.y + container.height, item.y + item.height)
    intersection = max(0.0, intersection_right - intersection_left) * max(
        0.0, intersection_bottom - intersection_top
    )
    item_area = item.width * item.height
    return intersection / item_area if item_area > 0 else 0.0


def _reconcile_one_piece_detections(
    grouped: dict[GarmentCategory, list[GarmentDetection]],
) -> None:
    retained_dresses: list[GarmentDetection] = []
    removed_top_ids: set[int] = set()
    removed_bottom_ids: set[int] = set()

    for one_piece in grouped["dress"]:
        overlapping_tops = [
            top
            for top in grouped["top"]
            if _covered_fraction(one_piece.box, top.box) >= 0.7
        ]
        overlapping_bottoms = [
            bottoms
            for bottoms in grouped["bottoms"]
            if _covered_fraction(one_piece.box, bottoms.box) >= 0.7
        ]
        overlapping_separates = [*overlapping_tops, *overlapping_bottoms]
        one_piece_is_strongest = overlapping_separates and all(
            one_piece.confidence > separate.confidence
            for separate in overlapping_separates
        )
        if overlapping_separates and not one_piece_is_strongest:
            continue

        retained_dresses.append(one_piece)
        removed_top_ids.update(id(top) for top in overlapping_tops)
        removed_bottom_ids.update(id(bottoms) for bottoms in overlapping_bottoms)

    grouped["dress"] = retained_dresses
    grouped["top"] = [item for item in grouped["top"] if id(item) not in removed_top_ids]
    grouped["bottoms"] = [
        item for item in grouped["bottoms"] if id(item) not in removed_bottom_ids
    ]


def build_garment_response(
    raw_detections: list[RawGarmentDetection],
    image_width: int,
    image_height: int,
    model_version: str,
    latency_ms: int,
    duplicate_iou_threshold: float = 0.6,
) -> GarmentPerceptionResponse:
    grouped: dict[GarmentCategory, list[GarmentDetection]] = {
        category: [] for category in CATEGORY_ORDER
    }

    for raw in sorted(raw_detections, key=lambda detection: detection.confidence, reverse=True):
        label = _normalise_label(raw.label)
        category = _category_for_label(label)
        box = _normalise_box(raw.box, image_width, image_height)
        if category is None or box is None:
            continue
        detection = GarmentDetection(
            category=category,
            matched_prompt=label,
            confidence=max(0.0, min(1.0, raw.confidence)),
            box=box,
        )
        if any(
            _intersection_over_union(detection.box, existing.box) >= duplicate_iou_threshold
            for existing in grouped[category]
        ):
            continue
        grouped[category].append(detection)

    _reconcile_one_piece_detections(grouped)
    categories = [
        GarmentCategoryResult(
            category=category,
            state="detected" if grouped[category] else "not_detected",
            detections=grouped[category],
        )
        for category in CATEGORY_ORDER
    ]
    return GarmentPerceptionResponse(
        model_version=model_version,
        categories=categories,
        latency_ms=latency_ms,
    )


def checkpoint_sha256(checkpoint_path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(checkpoint_path).open("rb") as checkpoint:
        for chunk in iter(lambda: checkpoint.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_checkpoint(checkpoint_path: Path, expected_sha256: str) -> None:
    if not checkpoint_path.is_file():
        raise InvalidGarmentCheckpointError(
            f"RF-DETR checkpoint does not exist: {checkpoint_path}"
        )
    actual_sha256 = checkpoint_sha256(checkpoint_path)
    if actual_sha256.lower() != expected_sha256.lower():
        raise InvalidGarmentCheckpointError(
            "RF-DETR checkpoint SHA-256 does not match the pinned Fashionpedia artifact."
        )


def _decode_rgb_images(image_bytes: Sequence[bytes]) -> tuple[list[Any], list[tuple[int, int]]]:
    try:
        image_module = import_module("PIL.Image")
        unidentified_error = import_module("PIL").UnidentifiedImageError
    except ImportError as error:
        raise GarmentModelNotReadyError("Garment perception requires Pillow.") from error

    decoded: list[Any] = []
    sizes: list[tuple[int, int]] = []
    try:
        for contents in image_bytes:
            try:
                image = image_module.open(BytesIO(contents)).convert("RGB")
                image.load()
            except (unidentified_error, OSError, ValueError) as error:
                raise InvalidGarmentImageError("Image could not be decoded.") from error
            decoded.append(image)
            sizes.append(image.size)
    except Exception:
        for image in decoded:
            image.close()
        raise
    return decoded, sizes


def _model_class_names(model: object) -> tuple[str, ...]:
    model_context = getattr(model, "model", None)
    class_names = getattr(model_context, "class_names", None)
    if class_names is None:
        class_names = getattr(model, "class_names", None)
    try:
        return validate_fashionpedia_class_names(class_names)
    except ValueError as error:
        raise InvalidGarmentCheckpointError(str(error)) from error


class GroundingDinoGarmentDetector:
    ready = True

    def __init__(
        self,
        model_id: str,
        box_threshold: float,
        text_threshold: float,
        device: str | None = None,
        local_files_only: bool = False,
    ) -> None:
        try:
            import torch
            from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor
        except ImportError as error:
            raise GarmentModelNotReadyError(
                "Garment perception requires the inference package's 'ml' extras."
            ) from error

        self._torch = torch
        self._processor = AutoProcessor.from_pretrained(
            model_id, local_files_only=local_files_only
        )
        self._device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        self._model = AutoModelForZeroShotObjectDetection.from_pretrained(
            model_id, local_files_only=local_files_only
        ).to(self._device)
        self._model.eval()
        self._box_threshold = box_threshold
        self._text_threshold = text_threshold
        self.model_version = model_id

    def detect(self, image_bytes: bytes) -> GarmentPerceptionResponse:
        return self.detect_many([image_bytes])[0]

    def detect_many(self, images: Sequence[bytes]) -> list[GarmentPerceptionResponse]:
        return [self._detect_one(image) for image in images]

    def _detect_one(self, image_bytes: bytes) -> GarmentPerceptionResponse:
        decoded, _ = _decode_rgb_images([image_bytes])
        image = decoded[0]
        try:
            started_at = perf_counter()
            inputs = self._processor(
                images=image,
                text=GROUNDING_DINO_PROMPT,
                return_tensors="pt",
            ).to(self._device)
            with self._torch.no_grad():
                outputs = self._model(**inputs)
            threshold_argument = grounding_dino_box_threshold_argument(self._processor)
            result = self._processor.post_process_grounded_object_detection(
                outputs,
                inputs.input_ids,
                **{
                    threshold_argument: self._box_threshold,
                    "text_threshold": self._text_threshold,
                    "target_sizes": [image.size[::-1]],
                },
            )[0]

            labels = result["text_labels"] if "text_labels" in result else result["labels"]
            raw_detections = [
                RawGarmentDetection(
                    label=str(label),
                    confidence=float(score),
                    box=tuple(float(value) for value in box),
                )
                for label, score, box in zip(
                    labels, result["scores"], result["boxes"], strict=True
                )
            ]
            return build_garment_response(
                raw_detections,
                image_width=image.width,
                image_height=image.height,
                model_version=self.model_version,
                latency_ms=round((perf_counter() - started_at) * 1000),
            )
        finally:
            image.close()


class RFDetrGarmentDetector:
    ready = True

    def __init__(
        self,
        checkpoint_path: str | Path,
        *,
        threshold: float = RFDETR_DEFAULT_THRESHOLD,
        device: str = "cuda",
        expected_sha256: str = RFDETR_CHECKPOINT_SHA256,
        model_factory: Callable[..., object] | None = None,
        torch_module: object | None = None,
        installed_rfdetr_version: str | None = None,
    ) -> None:
        if not 0 <= threshold <= 1:
            raise ValueError("RF-DETR threshold must be between 0 and 1.")
        # Apple silicon has no CUDA, so a CUDA-only runtime cannot be measured
        # against the latency gate on that hardware at all. MPS is accepted so
        # the gate can be run there; whether it is fast enough is what the gate
        # decides. CPU stays excluded — Grounding DINO already showed CPU
        # garment detection is far too slow to be live.
        if not (device.startswith("cuda") or device == "mps"):
            raise GarmentModelNotReadyError(
                "RF-DETR hackathon runtime requires CUDA or MPS; "
                f"got {device!r}."
            )

        checkpoint = Path(checkpoint_path).resolve()
        _verify_checkpoint(checkpoint, expected_sha256)

        if torch_module is None:
            try:
                torch_module = import_module("torch")
            except ImportError as error:
                raise GarmentModelNotReadyError("RF-DETR requires PyTorch.") from error
        if device == "mps":
            backends = getattr(torch_module, "backends", None)
            mps = getattr(backends, "mps", None) if backends else None
            if mps is None or not mps.is_available():
                raise GarmentModelNotReadyError("RF-DETR requires MPS-enabled PyTorch.")
        else:
            cuda = getattr(torch_module, "cuda", None)
            if cuda is None or not cuda.is_available():
                raise GarmentModelNotReadyError("RF-DETR requires CUDA-enabled PyTorch.")

        if model_factory is None:
            try:
                installed_version = version("rfdetr")
                model_factory = import_module("rfdetr").RFDETRSegSmall
            except (ImportError, PackageNotFoundError) as error:
                raise GarmentModelNotReadyError(
                    f"RF-DETR requires rfdetr=={RFDETR_PACKAGE_VERSION}."
                ) from error
        else:
            installed_version = installed_rfdetr_version or RFDETR_PACKAGE_VERSION
        if installed_version != RFDETR_PACKAGE_VERSION:
            raise GarmentModelNotReadyError(
                f"RF-DETR requires rfdetr=={RFDETR_PACKAGE_VERSION}; "
                f"found {installed_version}."
            )

        try:
            model = model_factory(
                pretrain_weights=str(checkpoint),
                trust_checkpoint=False,
                num_classes=FASHIONPEDIA_TOTAL_CLASS_COUNT,
                device=device,
            )
        except Exception as error:
            raise InvalidGarmentCheckpointError(
                "RF-DETR could not safely load the pinned Fashionpedia checkpoint."
            ) from error

        self._class_names = _model_class_names(model)
        inference = getattr(model, "inference", None)
        if not callable(inference):
            raise GarmentModelNotReadyError(
                "RF-DETR 1.9.3 does not expose its inference optimization API."
            )
        try:
            inference(compile=False, inplace=True, dtype="float16")
        except Exception as error:
            raise GarmentModelNotReadyError(
                "RF-DETR could not enable CUDA FP16 inference."
            ) from error

        self._model = model
        self._threshold = threshold
        self._checkpoint_sha256 = expected_sha256.lower()
        self.model_version = (
            "rfdetr-seg-small-fashionpedia"
            f"@{RFDETR_CHECKPOINT_REVISION[:8]}"
            f"+sha256:{self._checkpoint_sha256[:12]}"
        )

    def detect(self, image_bytes: bytes) -> GarmentPerceptionResponse:
        return self.detect_many([image_bytes])[0]

    def detect_many(self, images: Sequence[bytes]) -> list[GarmentPerceptionResponse]:
        if not images:
            return []
        decoded, sizes = _decode_rgb_images(images)
        try:
            started_at = perf_counter()
            predictions = self._model.predict(decoded, threshold=self._threshold)
            latency_ms = round((perf_counter() - started_at) * 1000)
            if len(decoded) == 1 and not isinstance(predictions, (list, tuple)):
                predictions = [predictions]
            if len(predictions) != len(decoded):
                raise GarmentInferenceError(
                    "RF-DETR returned a different number of predictions than input images."
                )

            responses: list[GarmentPerceptionResponse] = []
            for prediction, (width, height) in zip(predictions, sizes, strict=True):
                responses.append(
                    build_garment_response(
                        self._raw_detections(prediction),
                        image_width=width,
                        image_height=height,
                        model_version=self.model_version,
                        latency_ms=latency_ms,
                    )
                )
            return responses
        finally:
            for image in decoded:
                image.close()

    def _raw_detections(self, prediction: object) -> list[RawGarmentDetection]:
        boxes = getattr(prediction, "xyxy", None)
        confidences = getattr(prediction, "confidence", None)
        class_ids = getattr(prediction, "class_id", None)
        data = getattr(prediction, "data", None)
        class_names = data.get("class_name") if isinstance(data, dict) else None
        if boxes is None or confidences is None or class_ids is None or class_names is None:
            raise GarmentInferenceError(
                "RF-DETR prediction is missing boxes, confidence, class IDs, or class names."
            )

        raw: list[RawGarmentDetection] = []
        try:
            rows = zip(boxes, confidences, class_ids, class_names, strict=True)
            for box, confidence, class_id_value, class_name_value in rows:
                class_id = int(class_id_value)
                if not 0 <= class_id < FASHIONPEDIA_TOTAL_CLASS_COUNT:
                    raise GarmentInferenceError(
                        f"RF-DETR returned out-of-range Fashionpedia class ID {class_id}."
                    )
                class_name = normalize_fashionpedia_name(str(class_name_value))
                if class_name != self._class_names[class_id]:
                    raise GarmentInferenceError(
                        "RF-DETR class ID/name mapping does not match the pinned checkpoint."
                    )
                raw.append(
                    RawGarmentDetection(
                        label=class_name,
                        confidence=float(confidence),
                        box=tuple(float(value) for value in box),
                    )
                )
        except ValueError as error:
            raise GarmentInferenceError(
                "RF-DETR prediction arrays have inconsistent lengths."
            ) from error
        return raw


def default_accelerator() -> str:
    """
    Picks the accelerator to use when FITTED_GARMENT_DEVICE is unset.

    CUDA first so existing machines are unaffected, then Apple's MPS so the
    latency gate can be measured on a MacBook rather than refusing to start.
    Falls back to "cuda" so the failure message names the missing runtime
    rather than an unrelated device.
    """
    try:
        torch_module = import_module("torch")
    except ImportError:
        return "cuda"
    cuda = getattr(torch_module, "cuda", None)
    if cuda is not None and cuda.is_available():
        return "cuda"
    mps = getattr(getattr(torch_module, "backends", None), "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cuda"


def create_garment_detector(settings: Settings) -> GarmentDetector:
    if settings.garment_backend == "rfdetr":
        if not settings.garment_checkpoint_path:
            raise GarmentModelNotReadyError(
                "FITTED_GARMENT_CHECKPOINT_PATH is required for RF-DETR."
            )
        return RFDetrGarmentDetector(
            checkpoint_path=settings.garment_checkpoint_path,
            threshold=settings.garment_box_threshold,
            device=settings.garment_device or default_accelerator(),
        )
    if settings.garment_backend == "grounding_dino":
        if not settings.garment_model_id:
            raise GarmentModelNotReadyError(
                "FITTED_GARMENT_MODEL_ID is required for Grounding DINO."
            )
        return GroundingDinoGarmentDetector(
            model_id=settings.garment_model_id,
            box_threshold=settings.garment_box_threshold,
            text_threshold=settings.garment_text_threshold,
            device=settings.garment_device,
            local_files_only=settings.garment_local_files_only,
        )
    if settings.garment_backend:
        raise GarmentModelNotReadyError(
            f"Unsupported garment backend: {settings.garment_backend}."
        )
    if settings.garment_checkpoint_path:
        return RFDetrGarmentDetector(
            checkpoint_path=settings.garment_checkpoint_path,
            threshold=settings.garment_box_threshold,
            device=settings.garment_device or "cuda",
        )
    if not settings.garment_model_id:
        return UnavailableGarmentDetector()
    return GroundingDinoGarmentDetector(
        model_id=settings.garment_model_id,
        box_threshold=settings.garment_box_threshold,
        text_threshold=settings.garment_text_threshold,
        device=settings.garment_device,
        local_files_only=settings.garment_local_files_only,
    )
