import type { RoomRole } from "./signaling";
import type { NormalizedRect } from "./cv/types";

export type GarmentCategory =
  | "top"
  | "bottoms"
  | "dress"
  | "outerwear"
  | "shoes"
  | "bag"
  | "headwear"
  | "accessory";

export const GARMENT_LABELS: Record<GarmentCategory, string> = {
  top: "TOP",
  bottoms: "BOTTOMS",
  dress: "ONE-PIECE",
  outerwear: "OUTERWEAR",
  shoes: "SHOES",
  bag: "BAG",
  headwear: "HEADWEAR",
  accessory: "ACCESSORY",
};

export type GarmentDetection = {
  category: GarmentCategory;
  matchedPrompt: string;
  confidence: number;
  box: NormalizedRect;
};

type GarmentCategoryResult = {
  category: GarmentCategory;
  state: "detected" | "not_detected" | "not_present";
  detections: GarmentDetection[];
};

type GarmentPlayerResult = {
  categories: GarmentCategoryResult[];
};

export type GarmentOverlay = {
  cropBox: NormalizedRect;
  detections: GarmentDetection[];
};

export type GarmentPairResult = {
  battleId: string;
  pairId: string;
  playerACropBox: NormalizedRect;
  playerBCropBox: NormalizedRect;
  playerA: GarmentPlayerResult;
  playerB: GarmentPlayerResult;
};

const detectedCategories = (result: GarmentPlayerResult): GarmentCategory[] =>
  result.categories
    .filter((category) => category.state === "detected")
    .map((category) => category.category);

const detectedBoxes = (result: GarmentPlayerResult): GarmentDetection[] =>
  result.categories.flatMap((category) =>
    category.state === "detected" ? category.detections : [],
  );

const playerPerception = (
  result: GarmentPlayerResult,
  cropBox: NormalizedRect,
) => ({
  categories: detectedCategories(result),
  overlay: { cropBox, detections: detectedBoxes(result) } satisfies GarmentOverlay,
});

export function garmentPerceptionForRole(
  result: GarmentPairResult,
  role: RoomRole,
) {
  const playerA = playerPerception(result.playerA, result.playerACropBox);
  const playerB = playerPerception(result.playerB, result.playerBCropBox);
  return role === "host"
    ? { local: playerA, remote: playerB }
    : { local: playerB, remote: playerA };
}

export function garmentCategoriesForRole(
  result: GarmentPairResult,
  role: RoomRole,
) {
  const perception = garmentPerceptionForRole(result, role);
  return {
    localCategories: perception.local.categories,
    remoteCategories: perception.remote.categories,
  };
}
