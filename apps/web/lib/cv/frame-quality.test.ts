import { describe, expect, it } from "vitest";
import {
  classifyFrame,
  detectorUnavailableResult,
  measureImageQuality,
} from "./frame-quality";
import { calculateLandmarkMotion } from "./motion";
import { createPose } from "./test-fixtures";

const GOOD_IMAGE = { brightness: 0.5, sharpness: 0.8 };

describe("frame quality classification", () => {
  it("accepts a usable outfit when feet are not visible", () => {
    const pose = createPose();
    for (const index of [27, 28, 29, 30, 31, 32]) pose[index].visibility = 0.1;

    const result = classifyFrame(100, [pose], GOOD_IMAGE, 0);

    expect(result.observedStatus).toBe("valid");
    expect(result.visibleRegions.feet).toBe(false);
    expect(result.visibleRegions.legs).toBe(true);
  });

  it("rejects a frame without usable knees", () => {
    const pose = createPose();
    pose[25].visibility = 0.1;
    pose[26].visibility = 0.1;

    expect(classifyFrame(100, [pose], GOOD_IMAGE, 0).observedStatus).toBe(
      "partial_outfit",
    );
  });

  it("distinguishes no person and multiple people", () => {
    const weakPose = createPose();
    for (const index of [11, 12, 23, 24]) weakPose[index].visibility = 0.1;

    expect(classifyFrame(100, [weakPose], GOOD_IMAGE, 0).observedStatus).toBe(
      "no_person",
    );
    expect(
      classifyFrame(100, [createPose(), createPose()], GOOD_IMAGE, 0).observedStatus,
    ).toBe("multiple_people");
  });

  it("applies quality statuses in their specified priority", () => {
    const result = classifyFrame(
      100,
      [createPose()],
      { brightness: 0.05, sharpness: 0.01 },
      5,
    );
    expect(result.observedStatus).toBe("low_light");
  });

  it("reports rapid normalized landmark movement", () => {
    const previous = createPose();
    const current = createPose().map((landmark) => ({ ...landmark, x: landmark.x + 0.1 }));
    expect(calculateLandmarkMotion(previous, current, 100)).toBeGreaterThan(1.5);
  });

  it("measures brightness and sharpness on image-like data", () => {
    const width = 5;
    const height = 5;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < data.length; index += 4) {
      const value = (index / 4) % 2 === 0 ? 255 : 0;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
    const measured = measureImageQuality({ data, width, height } as ImageData);
    expect(measured.brightness).toBeGreaterThan(0.4);
    expect(measured.sharpness).toBeGreaterThan(0.12);
  });

  it("creates an explicit detector unavailable result", () => {
    const result = detectorUnavailableResult(123);
    expect(result.observedStatus).toBe("detector_unavailable");
    expect(result.scoreable).toBe(false);
    expect(result.capturedAt).toBe(123);
  });
});

