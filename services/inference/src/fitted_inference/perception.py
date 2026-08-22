from __future__ import annotations

from dataclasses import dataclass
from inspect import signature
from io import BytesIO
from time import perf_counter
from typing import Protocol

from .config import Settings
from .schemas import (
    GarmentCategory,
    GarmentCategoryResult,
    GarmentDetection,
    GarmentPerceptionResponse,
    NormalizedBox,
)

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


class InvalidGarmentImageError(ValueError):
    """Raised when uploaded bytes cannot be decoded as an image."""


@dataclass(frozen=True, slots=True)
class RawGarmentDetection:
    label: str
    confidence: float
    box: tuple[float, float, float, float]


class GarmentDetector(Protocol):
    ready: bool
    model_version: str

    def detect(self, image_bytes: bytes) -> GarmentPerceptionResponse: ...


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
            "No garment model is configured. Install the ML extras and set "
            "FITTED_GARMENT_MODEL_ID."
        )


def _normalise_label(label: str) -> str:
    return label.strip().lower().rstrip(".")


def _category_for_label(label: str) -> GarmentCategory | None:
    normalised = _normalise_label(label)
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


def _remove_conflicting_one_piece_detections(
    grouped: dict[GarmentCategory, list[GarmentDetection]],
) -> None:
    retained: list[GarmentDetection] = []
    for one_piece in grouped["dress"]:
        has_stronger_top = any(
            top.confidence >= one_piece.confidence
            and _covered_fraction(one_piece.box, top.box) >= 0.7
            for top in grouped["top"]
        )
        has_stronger_bottoms = any(
            bottoms.confidence >= one_piece.confidence
            and _covered_fraction(one_piece.box, bottoms.box) >= 0.7
            for bottoms in grouped["bottoms"]
        )
        if not (has_stronger_top and has_stronger_bottoms):
            retained.append(one_piece)
    grouped["dress"] = retained


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

    _remove_conflicting_one_piece_detections(grouped)
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
        try:
            from PIL import Image, UnidentifiedImageError

            image = Image.open(BytesIO(image_bytes)).convert("RGB")
        except (UnidentifiedImageError, OSError) as error:
            raise InvalidGarmentImageError("Image could not be decoded.") from error

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


def create_garment_detector(settings: Settings) -> GarmentDetector:
    if not settings.garment_model_id:
        return UnavailableGarmentDetector()
    return GroundingDinoGarmentDetector(
        model_id=settings.garment_model_id,
        box_threshold=settings.garment_box_threshold,
        text_threshold=settings.garment_text_threshold,
        device=settings.garment_device,
        local_files_only=settings.garment_local_files_only,
    )
