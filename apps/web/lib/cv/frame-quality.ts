import { CV_CONFIG } from "./config";
import { boundsFromLandmarks, expandAndClampRect } from "./crop";
import type {
  FrameObservation,
  FrameQualityMetrics,
  OutfitDetectionResult,
  PoseLandmark,
  VisibleRegions,
} from "./types";

const HEAD = [0, 7, 8];
const SHOULDERS = [11, 12];
const HIPS = [23, 24];
const KNEES = [25, 26];
const FEET = [27, 28, 29, 30, 31, 32];
const TORSO = [...SHOULDERS, ...HIPS];

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const mean = (values: number[]) =>
  values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
const visibilityAt = (landmarks: PoseLandmark[], index: number) =>
  clamp01(landmarks[index]?.visibility ?? 0);
const groupVisibilities = (landmarks: PoseLandmark[], indices: number[]) =>
  indices.map((index) => visibilityAt(landmarks, index));

export function poseConfidence(landmarks: PoseLandmark[]): number {
  return mean(groupVisibilities(landmarks, TORSO));
}

export function qualifyingPoses(poses: PoseLandmark[][]): PoseLandmark[][] {
  return poses.filter(
    (pose) => pose.length >= 33 && poseConfidence(pose) >= CV_CONFIG.poseVisibilityThreshold,
  );
}

export function visibleRegions(landmarks: PoseLandmark[]): VisibleRegions {
  const head = Math.max(...groupVisibilities(landmarks, HEAD));
  const shoulders = groupVisibilities(landmarks, SHOULDERS);
  const hips = groupVisibilities(landmarks, HIPS);
  const knees = groupVisibilities(landmarks, KNEES);
  const feet = groupVisibilities(landmarks, FEET);

  return {
    head: head >= CV_CONFIG.poseVisibilityThreshold,
    torso:
      Math.max(...shoulders) >= CV_CONFIG.poseVisibilityThreshold &&
      Math.max(...hips) >= CV_CONFIG.poseVisibilityThreshold &&
      mean([...shoulders, ...hips]) >= CV_CONFIG.poseVisibilityThreshold,
    legs:
      Math.max(...knees) >= CV_CONFIG.poseVisibilityThreshold &&
      Math.min(...knees) >= CV_CONFIG.secondaryVisibilityThreshold,
    feet: mean(feet) >= CV_CONFIG.poseVisibilityThreshold,
  };
}

export function measureImageQuality(imageData: ImageData) {
  const { data, width, height } = imageData;
  if (width < 3 || height < 3) return { brightness: 0, sharpness: 0 };

  const luminance = new Float32Array(width * height);
  let luminanceTotal = 0;
  for (let pixel = 0, offset = 0; pixel < luminance.length; pixel += 1, offset += 4) {
    const value =
      (0.2126 * data[offset] + 0.7152 * data[offset + 1] + 0.0722 * data[offset + 2]) /
      255;
    luminance[pixel] = value;
    luminanceTotal += value;
  }

  const brightness = luminanceTotal / luminance.length;
  let laplacianTotal = 0;
  let laplacianSquaredTotal = 0;
  let samples = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const value =
        luminance[index - 1] +
        luminance[index + 1] +
        luminance[index - width] +
        luminance[index + width] -
        4 * luminance[index];
      laplacianTotal += value;
      laplacianSquaredTotal += value * value;
      samples += 1;
    }
  }

  const laplacianMean = laplacianTotal / samples;
  const variance = laplacianSquaredTotal / samples - laplacianMean * laplacianMean;
  return { brightness, sharpness: clamp01(variance / 0.02) };
}

export function classifyFrame(
  capturedAt: number,
  poses: PoseLandmark[][],
  imageQuality: { brightness: number; sharpness: number },
  motion: number,
): FrameObservation {
  const qualified = qualifyingPoses(poses);
  const emptyQuality: FrameQualityMetrics = {
    poseConfidence: 0,
    landmarkVisibility: 0,
    personFrameCoverage: 0,
    sharpness: imageQuality.sharpness,
    brightness: imageQuality.brightness,
    motion,
  };
  const emptyRegions: VisibleRegions = {
    head: false,
    torso: false,
    legs: false,
    feet: false,
  };

  if (qualified.length === 0) {
    return {
      capturedAt,
      observedStatus: "no_person",
      personBox: null,
      cropBox: null,
      landmarks: [],
      visibleRegions: emptyRegions,
      quality: emptyQuality,
    };
  }

  if (qualified.length > 1) {
    return {
      capturedAt,
      observedStatus: "multiple_people",
      personBox: null,
      cropBox: null,
      landmarks: [],
      visibleRegions: emptyRegions,
      quality: emptyQuality,
    };
  }

  const landmarks = qualified[0];
  const regions = visibleRegions(landmarks);
  const personBox = boundsFromLandmarks(landmarks);
  const landmarkVisibility = mean([
    Math.max(...groupVisibilities(landmarks, HEAD)),
    ...groupVisibilities(landmarks, TORSO),
    ...groupVisibilities(landmarks, KNEES),
  ]);
  const quality: FrameQualityMetrics = {
    poseConfidence: poseConfidence(landmarks),
    landmarkVisibility,
    personFrameCoverage: personBox?.height ?? 0,
    sharpness: imageQuality.sharpness,
    brightness: imageQuality.brightness,
    motion,
  };

  let observedStatus: FrameObservation["observedStatus"] = "valid";
  if (!personBox || !regions.head || !regions.torso || !regions.legs) {
    observedStatus = "partial_outfit";
  } else if (
    personBox.height > CV_CONFIG.maximumPersonHeight ||
    personBox.x < CV_CONFIG.minimumBorderClearance ||
    personBox.y < CV_CONFIG.minimumBorderClearance ||
    personBox.x + personBox.width > 1 - CV_CONFIG.minimumBorderClearance
  ) {
    observedStatus = "too_close";
  } else if (personBox.height < CV_CONFIG.minimumPersonHeight) {
    observedStatus = "too_far";
  } else if (quality.brightness < CV_CONFIG.lowLightThreshold) {
    observedStatus = "low_light";
  } else if (quality.sharpness < CV_CONFIG.blurThreshold) {
    observedStatus = "blurred";
  } else if (quality.motion > CV_CONFIG.rapidMotionThreshold) {
    observedStatus = "moving_too_fast";
  }

  return {
    capturedAt,
    observedStatus,
    personBox,
    cropBox: personBox ? expandAndClampRect(personBox) : null,
    landmarks,
    visibleRegions: regions,
    quality,
  };
}

export function detectorUnavailableResult(capturedAt: number): OutfitDetectionResult {
  return {
    capturedAt,
    observedStatus: "detector_unavailable",
    stableStatus: "detector_unavailable",
    scoreable: false,
    personBox: null,
    cropBox: null,
    landmarks: [],
    visibleRegions: { head: false, torso: false, legs: false, feet: false },
    quality: {
      poseConfidence: 0,
      landmarkVisibility: 0,
      personFrameCoverage: 0,
      sharpness: 0,
      brightness: 0,
      motion: 0,
    },
    processingMs: 0,
  };
}
