import type { FrameQualityMetrics, PoseLandmark } from "./types";

export function createPose(): PoseLandmark[] {
  const landmarks = Array.from({ length: 33 }, () => ({
    x: 0.5,
    y: 0.5,
    z: 0,
    visibility: 0.1,
  }));
  const set = (index: number, x: number, y: number, visibility = 0.9) => {
    landmarks[index] = { x, y, z: 0, visibility };
  };

  set(0, 0.5, 0.05);
  set(7, 0.47, 0.07);
  set(8, 0.53, 0.07);
  set(11, 0.4, 0.2);
  set(12, 0.6, 0.2);
  set(23, 0.43, 0.48);
  set(24, 0.57, 0.48);
  set(25, 0.44, 0.73);
  set(26, 0.56, 0.73);
  set(27, 0.44, 0.9);
  set(28, 0.56, 0.9);
  set(29, 0.43, 0.92);
  set(30, 0.57, 0.92);
  set(31, 0.42, 0.94);
  set(32, 0.58, 0.94);
  return landmarks;
}

export function createQuality(
  overrides: Partial<FrameQualityMetrics> = {},
): FrameQualityMetrics {
  return {
    poseConfidence: 0.9,
    landmarkVisibility: 0.9,
    personFrameCoverage: 0.7,
    sharpness: 0.8,
    brightness: 0.5,
    motion: 0,
    ...overrides,
  };
}

