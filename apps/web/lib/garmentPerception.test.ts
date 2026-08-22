import { describe, expect, it } from "vitest";
import {
  garmentCategoriesForRole,
  garmentPerceptionForRole,
  type GarmentPairResult,
} from "./garmentPerception";

const result: GarmentPairResult = {
  battleId: "FIT-1234",
  pairId: "pair-1",
  playerACropBox: { x: 0.1, y: 0.05, width: 0.8, height: 0.9 },
  playerBCropBox: { x: 0.2, y: 0.1, width: 0.6, height: 0.8 },
  playerA: {
    categories: [
      {
        category: "top",
        state: "detected",
        detections: [{
          category: "top",
          matchedPrompt: "shirt/blouse",
          confidence: 0.91,
          box: { x: 0.2, y: 0.1, width: 0.5, height: 0.4 },
        }],
      },
      { category: "bottoms", state: "not_detected", detections: [] },
    ],
  },
  playerB: {
    categories: [
      {
        category: "dress",
        state: "detected",
        detections: [{
          category: "dress",
          matchedPrompt: "dress",
          confidence: 0.88,
          box: { x: 0.1, y: 0.05, width: 0.75, height: 0.8 },
        }],
      },
      {
        category: "shoes",
        state: "detected",
        detections: [{
          category: "shoes",
          matchedPrompt: "shoe",
          confidence: 0.79,
          box: { x: 0.15, y: 0.85, width: 0.2, height: 0.1 },
        }],
      },
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

  it("keeps each role's exact crop-relative boxes with its source crop", () => {
    const perception = garmentPerceptionForRole(result, "guest");
    expect(perception.local.overlay.cropBox).toEqual(result.playerBCropBox);
    expect(perception.local.overlay.detections.map(({ category }) => category)).toEqual([
      "dress",
      "shoes",
    ]);
    expect(perception.remote.overlay.cropBox).toEqual(result.playerACropBox);
    expect(perception.remote.overlay.detections[0].matchedPrompt).toBe("shirt/blouse");
  });
});
