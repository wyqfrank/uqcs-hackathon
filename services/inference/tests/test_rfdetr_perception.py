from __future__ import annotations

import hashlib
from io import BytesIO
from types import SimpleNamespace

import pytest
from PIL import Image

import fitted_inference.perception as perception
from fitted_inference.fashionpedia import (
    FASHIONPEDIA_CLASS_NAMES,
    FASHIONPEDIA_GARMENT_CLASS_COUNT,
    FASHIONPEDIA_PART_CLASS_NAMES,
    FASHIONPEDIA_PRODUCT_CATEGORIES,
    fashionpedia_category_for_name,
)
from fitted_inference.perception import (
    GarmentModelNotReadyError,
    InvalidGarmentCheckpointError,
    InvalidGarmentImageError,
    RawGarmentDetection,
    RFDetrGarmentDetector,
    build_garment_response,
)


class FakeCuda:
    def __init__(self, available: bool = True) -> None:
        self.available = available

    def is_available(self) -> bool:
        return self.available


class FakeTorch:
    def __init__(self, cuda_available: bool = True) -> None:
        self.cuda = FakeCuda(cuda_available)


class FakePrediction:
    def __init__(
        self,
        class_id: int,
        *,
        class_name: str | None = None,
        box: list[float] | None = None,
        mask: object | None = None,
    ) -> None:
        self.xyxy = [box or [0, 0, 50, 100]]
        self.confidence = [0.9]
        self.class_id = [class_id]
        self.data = {
            "class_name": [class_name or FASHIONPEDIA_CLASS_NAMES[class_id]],
        }
        self.mask = mask


class FakeModel:
    def __init__(
        self,
        predictions: list[FakePrediction] | None = None,
        class_names: tuple[str, ...] = FASHIONPEDIA_CLASS_NAMES,
    ) -> None:
        self.model = SimpleNamespace(class_names=list(class_names))
        self.predictions = predictions or []
        self.predict_calls = []
        self.inference_calls = []

    def inference(self, **kwargs) -> None:
        self.inference_calls.append(kwargs)

    def predict(self, images, threshold):
        self.predict_calls.append((list(images), threshold))
        return self.predictions[: len(images)]


def png_bytes(size: tuple[int, int] = (100, 200)) -> bytes:
    output = BytesIO()
    Image.new("RGB", size, "navy").save(output, "PNG")
    return output.getvalue()


def make_checkpoint(tmp_path, contents: bytes = b"safe checkpoint"):
    path = tmp_path / "fashionpedia.pth"
    path.write_bytes(contents)
    return path, hashlib.sha256(contents).hexdigest()


def make_detector(tmp_path, model: FakeModel) -> RFDetrGarmentDetector:
    path, digest = make_checkpoint(tmp_path)
    return RFDetrGarmentDetector(
        path,
        expected_sha256=digest,
        model_factory=lambda **_kwargs: model,
        torch_module=FakeTorch(),
        installed_rfdetr_version="1.9.3",
    )


def by_category(response):
    return {result.category: result for result in response.categories}


def test_all_main_and_part_fashionpedia_classes_have_fixed_handling() -> None:
    main_names = FASHIONPEDIA_CLASS_NAMES[:FASHIONPEDIA_GARMENT_CLASS_COUNT]

    assert len(main_names) == 27
    assert len(FASHIONPEDIA_PART_CLASS_NAMES) == 19
    for name, expected in zip(
        main_names,
        FASHIONPEDIA_PRODUCT_CATEGORIES,
        strict=True,
    ):
        assert fashionpedia_category_for_name(name) == expected
    assert all(
        fashionpedia_category_for_name(name) is None
        for name in FASHIONPEDIA_PART_CLASS_NAMES
    )


@pytest.mark.parametrize(
    "wrong_names",
    [
        FASHIONPEDIA_CLASS_NAMES[:-1],
        (*FASHIONPEDIA_CLASS_NAMES[1:], FASHIONPEDIA_CLASS_NAMES[0]),
    ],
)
def test_bad_checkpoint_class_count_or_order_fails_startup(tmp_path, wrong_names) -> None:
    with pytest.raises(InvalidGarmentCheckpointError, match="class names/order"):
        make_detector(tmp_path, FakeModel(class_names=wrong_names))


def test_sha_mismatch_fails_before_deserialization(tmp_path) -> None:
    path, _ = make_checkpoint(tmp_path)
    factory_called = False

    def factory(**_kwargs):
        nonlocal factory_called
        factory_called = True
        return FakeModel()

    with pytest.raises(InvalidGarmentCheckpointError, match="SHA-256"):
        RFDetrGarmentDetector(
            path,
            expected_sha256="0" * 64,
            model_factory=factory,
            torch_module=FakeTorch(),
            installed_rfdetr_version="1.9.3",
        )
    assert factory_called is False


def test_detector_uses_safe_load_and_fp16_configuration(tmp_path) -> None:
    path, digest = make_checkpoint(tmp_path)
    received = {}
    model = FakeModel()

    def factory(**kwargs):
        received.update(kwargs)
        return model

    RFDetrGarmentDetector(
        path,
        expected_sha256=digest,
        model_factory=factory,
        torch_module=FakeTorch(),
        installed_rfdetr_version="1.9.3",
    )

    assert received == {
        "pretrain_weights": str(path.resolve()),
        "trust_checkpoint": False,
        "num_classes": 46,
        "device": "cuda",
    }
    assert model.inference_calls == [
        {"compile": False, "inplace": True, "dtype": "float16"}
    ]


@pytest.mark.parametrize("contents", [b"", b"not-an-image"])
def test_invalid_images_are_rejected(tmp_path, contents) -> None:
    detector = make_detector(tmp_path, FakeModel())
    with pytest.raises(InvalidGarmentImageError, match="could not be decoded"):
        detector.detect(contents)


def test_detect_many_preserves_pair_order_and_ignores_masks(tmp_path) -> None:
    model = FakeModel(
        [
            FakePrediction(0, mask=object()),
            FakePrediction(6, box=[0, 100, 100, 200], mask=object()),
        ]
    )
    detector = make_detector(tmp_path, model)

    responses = detector.detect_many([png_bytes(), png_bytes()])

    assert len(model.predict_calls) == 1
    assert len(model.predict_calls[0][0]) == 2
    assert model.predict_calls[0][1] == 0.5
    assert by_category(responses[0])["top"].state == "detected"
    assert by_category(responses[1])["bottoms"].state == "detected"


def test_detect_matches_single_item_detect_many(tmp_path) -> None:
    detector = make_detector(tmp_path, FakeModel([FakePrediction(0)]))
    image = png_bytes()

    direct = detector.detect(image).model_dump(exclude={"latency_ms"})
    batched = detector.detect_many([image])[0].model_dump(exclude={"latency_ms"})

    assert direct == batched


def test_stronger_one_piece_removes_overlapping_separates_but_not_outerwear() -> None:
    response = build_garment_response(
        [
            RawGarmentDetection("dress", 0.95, (0, 0, 100, 200)),
            RawGarmentDetection("shirt, blouse", 0.8, (0, 0, 100, 90)),
            RawGarmentDetection("pants", 0.7, (0, 100, 100, 200)),
            RawGarmentDetection("jacket", 0.6, (0, 0, 100, 130)),
        ],
        100,
        200,
        "fake",
        0,
    )
    grouped = by_category(response)

    assert grouped["dress"].state == "detected"
    assert grouped["top"].state == "not_detected"
    assert grouped["bottoms"].state == "not_detected"
    assert grouped["outerwear"].state == "detected"


def test_multiple_shoes_are_retained_as_one_detected_category() -> None:
    response = build_garment_response(
        [
            RawGarmentDetection("shoe", 0.9, (5, 170, 40, 200)),
            RawGarmentDetection("shoe", 0.85, (60, 170, 95, 200)),
        ],
        100,
        200,
        "fake",
        0,
    )

    assert len(by_category(response)["shoes"].detections) == 2


def test_missing_rfdetr_and_cuda_report_not_ready(tmp_path, monkeypatch) -> None:
    path, digest = make_checkpoint(tmp_path)

    def missing_version(_package):
        raise perception.PackageNotFoundError

    monkeypatch.setattr(perception, "version", missing_version)
    with pytest.raises(GarmentModelNotReadyError, match="rfdetr==1.9.3"):
        RFDetrGarmentDetector(path, expected_sha256=digest, torch_module=FakeTorch())

    with pytest.raises(GarmentModelNotReadyError, match="CUDA-enabled"):
        RFDetrGarmentDetector(
            path,
            expected_sha256=digest,
            model_factory=lambda **_kwargs: FakeModel(),
            torch_module=FakeTorch(cuda_available=False),
            installed_rfdetr_version="1.9.3",
        )
