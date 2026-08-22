from .schemas import GarmentCategory

FASHIONPEDIA_GARMENT_CLASS_COUNT = 27
FASHIONPEDIA_TOTAL_CLASS_COUNT = 46

# Canonical annotation order. Checkpoints with any different embedded ordering
# are rejected before they can be used for public garment categories.
FASHIONPEDIA_CLASS_NAMES: tuple[str, ...] = (
    "shirt, blouse",
    "top, t-shirt, sweatshirt",
    "sweater",
    "cardigan",
    "jacket",
    "vest",
    "pants",
    "shorts",
    "skirt",
    "coat",
    "dress",
    "jumpsuit",
    "cape",
    "glasses",
    "hat",
    "headband, head covering, hair accessory",
    "tie",
    "glove",
    "watch",
    "belt",
    "leg warmer",
    "tights, stockings",
    "sock",
    "shoe",
    "bag, wallet",
    "scarf",
    "umbrella",
    "hood",
    "collar",
    "lapel",
    "epaulette",
    "sleeve",
    "pocket",
    "neckline",
    "buckle",
    "zipper",
    "applique",
    "bead",
    "bow",
    "flower",
    "fringe",
    "ribbon",
    "rivet",
    "ruffle",
    "sequin",
    "tassel",
)

FASHIONPEDIA_PRODUCT_CATEGORIES: tuple[GarmentCategory, ...] = (
    "top",
    "top",
    "top",
    "outerwear",
    "outerwear",
    "outerwear",
    "bottoms",
    "bottoms",
    "bottoms",
    "outerwear",
    "dress",
    "dress",
    "outerwear",
    "accessory",
    "headwear",
    "headwear",
    "accessory",
    "accessory",
    "accessory",
    "accessory",
    "accessory",
    "accessory",
    "accessory",
    "shoes",
    "bag",
    "accessory",
    "accessory",
)

FASHIONPEDIA_PART_CLASS_NAMES = FASHIONPEDIA_CLASS_NAMES[
    FASHIONPEDIA_GARMENT_CLASS_COUNT:
]
FASHIONPEDIA_NAME_TO_CATEGORY = dict(
    zip(
        FASHIONPEDIA_CLASS_NAMES[:FASHIONPEDIA_GARMENT_CLASS_COUNT],
        FASHIONPEDIA_PRODUCT_CATEGORIES,
        strict=True,
    )
)


def normalize_fashionpedia_name(name: str) -> str:
    return " ".join(name.strip().lower().split())


def fashionpedia_category_for_name(name: str) -> GarmentCategory | None:
    return FASHIONPEDIA_NAME_TO_CATEGORY.get(normalize_fashionpedia_name(name))


def validate_fashionpedia_class_names(class_names: object) -> tuple[str, ...]:
    if not isinstance(class_names, (list, tuple)):
        raise ValueError("RF-DETR checkpoint does not expose an ordered class-name list.")
    normalized = tuple(normalize_fashionpedia_name(str(name)) for name in class_names)
    if normalized != FASHIONPEDIA_CLASS_NAMES:
        raise ValueError(
            "RF-DETR checkpoint class names/order do not match the 46 Fashionpedia classes."
        )
    return normalized
