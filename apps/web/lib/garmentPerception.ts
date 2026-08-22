import type { RoomRole } from "./signaling";

export type GarmentCategory =
  | "top"
  | "bottoms"
  | "dress"
  | "outerwear"
  | "shoes"
  | "bag"
  | "headwear"
  | "accessory";

type GarmentCategoryResult = {
  category: GarmentCategory;
  state: "detected" | "not_detected" | "not_present";
};

type GarmentPlayerResult = {
  categories: GarmentCategoryResult[];
};

export type GarmentPairResult = {
  battleId: string;
  pairId: string;
  playerA: GarmentPlayerResult;
  playerB: GarmentPlayerResult;
};

const detectedCategories = (result: GarmentPlayerResult): GarmentCategory[] =>
  result.categories
    .filter((category) => category.state === "detected")
    .map((category) => category.category);

export function garmentCategoriesForRole(
  result: GarmentPairResult,
  role: RoomRole,
) {
  const local = role === "host" ? result.playerA : result.playerB;
  const remote = role === "host" ? result.playerB : result.playerA;
  return {
    localCategories: detectedCategories(local),
    remoteCategories: detectedCategories(remote),
  };
}
