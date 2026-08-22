from __future__ import annotations

import argparse
import json
import math
import platform
import sys
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from statistics import median
from time import perf_counter

from fitted_inference.perception import (
    RFDETR_CHECKPOINT_REVISION,
    RFDETR_DEFAULT_THRESHOLD,
    RFDetrGarmentDetector,
    checkpoint_sha256,
)

WARMUP_BATCHES = 3
MEASURED_BATCHES = 20
BATCH_SIZE = 2
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Benchmark paired RF-DETR Fashionpedia inference on CUDA."
    )
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--fixtures", required=True, type=Path)
    return parser.parse_args()


def installed_version(package: str) -> str | None:
    try:
        return version(package)
    except PackageNotFoundError:
        return None


def percentile(values: list[float], percentile_value: float) -> float:
    ordered = sorted(values)
    index = max(0, math.ceil(percentile_value * len(ordered)) - 1)
    return ordered[index]


def load_fixture_bytes(fixtures: Path) -> list[bytes]:
    if not fixtures.is_dir():
        raise ValueError(f"Fixture directory does not exist: {fixtures}")
    paths = sorted(
        path
        for path in fixtures.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )
    if len(paths) < BATCH_SIZE:
        raise ValueError("Benchmark requires at least two fixture images.")
    return [path.read_bytes() for path in paths]


def batch_for(fixtures: list[bytes], batch_index: int) -> list[bytes]:
    start = (batch_index * BATCH_SIZE) % len(fixtures)
    return [fixtures[(start + offset) % len(fixtures)] for offset in range(BATCH_SIZE)]


def detected_categories(response: object) -> list[str]:
    return [
        result.category
        for result in response.categories  # type: ignore[attr-defined]
        if result.state == "detected"
    ]


def main() -> int:
    args = parse_args()
    try:
        import torch

        fixture_bytes = load_fixture_bytes(args.fixtures)
        detector = RFDetrGarmentDetector(
            args.checkpoint,
            threshold=RFDETR_DEFAULT_THRESHOLD,
            device="cuda",
        )

        for index in range(WARMUP_BATCHES):
            detector.detect_many(batch_for(fixture_bytes, index))
        torch.cuda.synchronize()
        torch.cuda.reset_peak_memory_stats()

        latency_ms: list[float] = []
        predictions: list[list[list[str]]] = []
        for index in range(MEASURED_BATCHES):
            batch = batch_for(fixture_bytes, index + WARMUP_BATCHES)
            torch.cuda.synchronize()
            started_at = perf_counter()
            responses = detector.detect_many(batch)
            torch.cuda.synchronize()
            latency_ms.append((perf_counter() - started_at) * 1000)
            predictions.append([detected_categories(response) for response in responses])

        result = {
            "configuration": {
                "warmupBatches": WARMUP_BATCHES,
                "measuredBatches": MEASURED_BATCHES,
                "batchSize": BATCH_SIZE,
                "threshold": RFDETR_DEFAULT_THRESHOLD,
                "device": "cuda",
            },
            "versions": {
                "python": platform.python_version(),
                "rfdetr": installed_version("rfdetr"),
                "torch": installed_version("torch"),
                "torchvision": installed_version("torchvision"),
                "pillow": installed_version("pillow"),
            },
            "modelVersion": detector.model_version,
            "checkpointRevision": RFDETR_CHECKPOINT_REVISION,
            "checkpointSha256": checkpoint_sha256(args.checkpoint),
            "gpuName": torch.cuda.get_device_name(),
            "p50LatencyMs": round(median(latency_ms), 2),
            "p95LatencyMs": round(percentile(latency_ms, 0.95), 2),
            "peakVramBytes": torch.cuda.max_memory_reserved(),
            "peakVramAllocatedBytes": torch.cuda.max_memory_allocated(),
            "peakVramReservedBytes": torch.cuda.max_memory_reserved(),
            "completedMeasuredBatches": len(latency_ms),
            "predictedReducedCategories": predictions,
        }
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except Exception as error:
        print(
            json.dumps(
                {"error": type(error).__name__, "message": str(error)},
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
