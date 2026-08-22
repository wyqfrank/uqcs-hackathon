from fitted_inference.perception import (
    RawGarmentDetection,
    build_garment_response,
    grounding_dino_box_threshold_argument,
)


def test_grounding_dino_threshold_argument_supports_transformers_versions() -> None:
    class Transformers4Processor:
        def post_process_grounded_object_detection(self, *, box_threshold):
            del box_threshold

    class Transformers5Processor:
        def post_process_grounded_object_detection(self, *, threshold):
            del threshold

    assert grounding_dino_box_threshold_argument(Transformers4Processor()) == "box_threshold"
    assert grounding_dino_box_threshold_argument(Transformers5Processor()) == "threshold"


def test_build_response_maps_prompts_to_product_taxonomy() -> None:
    response = build_garment_response(
        [
            RawGarmentDetection("shirt", 0.92, (10, 20, 90, 100)),
            RawGarmentDetection("pants jeans", 0.84, (15, 95, 85, 190)),
            RawGarmentDetection("unknown object", 0.99, (0, 0, 10, 10)),
        ],
        image_width=100,
        image_height=200,
        model_version="test-model",
        latency_ms=12,
    )

    by_category = {result.category: result for result in response.categories}
    assert by_category["top"].state == "detected"
    assert by_category["top"].detections[0].box.model_dump() == {
        "x": 0.1,
        "y": 0.1,
        "width": 0.8,
        "height": 0.4,
    }
    assert by_category["bottoms"].state == "detected"
    assert by_category["dress"].state == "not_detected"
    assert by_category["dress"].detections == []


def test_build_response_deduplicates_overlapping_synonyms() -> None:
    response = build_garment_response(
        [
            RawGarmentDetection("jacket", 0.91, (10, 10, 90, 100)),
            RawGarmentDetection("coat", 0.72, (12, 12, 88, 98)),
        ],
        image_width=100,
        image_height=200,
        model_version="test-model",
        latency_ms=5,
    )

    outerwear = next(result for result in response.categories if result.category == "outerwear")
    assert [detection.matched_prompt for detection in outerwear.detections] == ["jacket"]


def test_build_response_suppresses_weaker_one_piece_over_separates() -> None:
    response = build_garment_response(
        [
            RawGarmentDetection("shirt", 0.8, (20, 10, 80, 90)),
            RawGarmentDetection("jeans", 0.75, (20, 85, 80, 190)),
            RawGarmentDetection("dress", 0.6, (15, 5, 85, 195)),
        ],
        image_width=100,
        image_height=200,
        model_version="test-model",
        latency_ms=5,
    )

    by_category = {result.category: result for result in response.categories}
    assert by_category["top"].state == "detected"
    assert by_category["bottoms"].state == "detected"
    assert by_category["dress"].state == "not_detected"


def test_build_response_retains_strong_one_piece_detection() -> None:
    response = build_garment_response(
        [
            RawGarmentDetection("shirt", 0.6, (20, 10, 80, 90)),
            RawGarmentDetection("jeans", 0.55, (20, 85, 80, 190)),
            RawGarmentDetection("dress", 0.9, (15, 5, 85, 195)),
        ],
        image_width=100,
        image_height=200,
        model_version="test-model",
        latency_ms=5,
    )

    dress = next(result for result in response.categories if result.category == "dress")
    assert dress.state == "detected"
    assert dress.detections[0].confidence == 0.9


def test_build_response_clamps_boxes_and_discards_empty_boxes() -> None:
    response = build_garment_response(
        [
            RawGarmentDetection("shoes", 1.2, (-10, 150, 120, 220)),
            RawGarmentDetection("hat", 0.8, (50, 50, 50, 70)),
        ],
        image_width=100,
        image_height=200,
        model_version="test-model",
        latency_ms=5,
    )

    by_category = {result.category: result for result in response.categories}
    shoes = by_category["shoes"].detections[0]
    assert shoes.confidence == 1
    assert shoes.box.model_dump() == {"x": 0, "y": 0.75, "width": 1, "height": 0.25}
    assert by_category["headwear"].state == "not_detected"
