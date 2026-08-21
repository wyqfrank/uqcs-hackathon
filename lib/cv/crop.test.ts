import { describe, expect, it } from "vitest";
import {
  boundsFromLandmarks,
  expandAndClampRect,
  mirrorRect,
  rectToPixels,
} from "./crop";
import { createPose } from "./test-fixtures";

describe("canonical crop geometry", () => {
  it("builds a padded crop and clamps it inside the source", () => {
    const bounds = boundsFromLandmarks(createPose());
    expect(bounds).not.toBeNull();
    const crop = expandAndClampRect(bounds!, 0.15);
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(1);
    expect(crop.y + crop.height).toBeLessThanOrEqual(1);
    expect(crop.width).toBeGreaterThan(bounds!.width);
  });

  it("mirrors only the horizontal overlay coordinate", () => {
    const mirrored = mirrorRect({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
    expect(mirrored.x).toBeCloseTo(0.6);
    expect(mirrored.y).toBe(0.2);
    expect(mirrored.width).toBe(0.3);
    expect(mirrored.height).toBe(0.4);
  });

  it("converts normalized coordinates into safe source pixels", () => {
    expect(rectToPixels({ x: 0.1, y: 0.2, width: 0.5, height: 0.4 }, 640, 480)).toEqual({
      x: 64,
      y: 96,
      width: 320,
      height: 192,
    });
  });
});
