import { describe, expect, it } from "vitest";
import { garmentCategoriesForRole, type GarmentPairResult } from "./garmentPerception";

const result: GarmentPairResult = {
  battleId: "FIT-1234",
  pairId: "pair-1",
  playerA: {
    categories: [
      { category: "top", state: "detected" },
      { category: "bottoms", state: "not_detected" },
    ],
  },
  playerB: {
    categories: [
      { category: "dress", state: "detected" },
      { category: "shoes", state: "detected" },
    ],
  },
};

describe("garmentCategoriesForRole", () => {
  it("maps player A to the host and excludes missing categories", () => {
    expect(garmentCategoriesForRole(result, "host")).toEqual({
      localCategories: ["top"],
      remoteCategories: ["dress", "shoes"],
    });
  });

  it("maps player B to the guest", () => {
    expect(garmentCategoriesForRole(result, "guest")).toEqual({
      localCategories: ["dress", "shoes"],
      remoteCategories: ["top"],
    });
  });
});
