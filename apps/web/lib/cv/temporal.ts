import { CV_CONFIG } from "./config";
import type {
  FrameObservation,
  NormalizedRect,
  OutfitDetectionResult,
  OutfitFrameStatus,
  PoseLandmark,
} from "./types";

const smoothValue = (previous: number, current: number) =>
  0.4 * current + 0.6 * previous;

const smoothRect = (
  previous: NormalizedRect | null,
  current: NormalizedRect | null,
): NormalizedRect | null => {
  if (!previous || !current) return current;
  return {
    x: smoothValue(previous.x, current.x),
    y: smoothValue(previous.y, current.y),
    width: smoothValue(previous.width, current.width),
    height: smoothValue(previous.height, current.height),
  };
};

const smoothLandmarks = (previous: PoseLandmark[], current: PoseLandmark[]) => {
  if (previous.length !== current.length) return current;
  return current.map((landmark, index) => ({
    x: smoothValue(previous[index].x, landmark.x),
    y: smoothValue(previous[index].y, landmark.y),
    z: smoothValue(previous[index].z, landmark.z),
    visibility: landmark.visibility,
  }));
};

export class DetectionStabilizer {
  private stableStatus: OutfitFrameStatus = "no_person";
  private validStreak = 0;
  private invalidStreak = 0;
  private lastValidAt = Number.NEGATIVE_INFINITY;
  private lastPersonBox: NormalizedRect | null = null;
  private lastCropBox: NormalizedRect | null = null;
  private lastLandmarks: PoseLandmark[] = [];

  reset() {
    this.stableStatus = "no_person";
    this.validStreak = 0;
    this.invalidStreak = 0;
    this.lastValidAt = Number.NEGATIVE_INFINITY;
    this.lastPersonBox = null;
    this.lastCropBox = null;
    this.lastLandmarks = [];
  }

  update(observation: FrameObservation, processingMs = 0): OutfitDetectionResult {
    const isObservedValid = observation.observedStatus === "valid";

    if (isObservedValid) {
      this.validStreak += 1;
      this.invalidStreak = 0;
      this.lastValidAt = observation.capturedAt;
      this.lastPersonBox = smoothRect(this.lastPersonBox, observation.personBox);
      this.lastCropBox = smoothRect(this.lastCropBox, observation.cropBox);
      this.lastLandmarks = smoothLandmarks(this.lastLandmarks, observation.landmarks);
      if (this.validStreak >= CV_CONFIG.validObservationsRequired) {
        this.stableStatus = "valid";
      }
    } else {
      this.validStreak = 0;
      this.invalidStreak += 1;
      if (
        this.stableStatus !== "valid" ||
        this.invalidStreak >= CV_CONFIG.invalidObservationsRequired
      ) {
        this.stableStatus = observation.observedStatus;
      }
    }

    const mayHoldGeometry =
      observation.capturedAt - this.lastValidAt <= CV_CONFIG.maximumResultAgeMs;
    const useCurrentGeometry = isObservedValid;

    return {
      ...observation,
      stableStatus: this.stableStatus,
      scoreable: isObservedValid && this.stableStatus === "valid",
      personBox: useCurrentGeometry
        ? this.lastPersonBox
        : mayHoldGeometry
          ? this.lastPersonBox
          : observation.personBox,
      cropBox: useCurrentGeometry
        ? this.lastCropBox
        : mayHoldGeometry
          ? this.lastCropBox
          : observation.cropBox,
      landmarks: useCurrentGeometry
        ? this.lastLandmarks
        : mayHoldGeometry
          ? this.lastLandmarks
          : observation.landmarks,
      processingMs,
    };
  }
}

