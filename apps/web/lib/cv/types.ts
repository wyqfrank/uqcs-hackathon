export type OutfitFrameStatus =
  | "valid"
  | "no_person"
  | "multiple_people"
  | "partial_outfit"
  | "too_close"
  | "too_far"
  | "low_light"
  | "blurred"
  | "moving_too_fast"
  | "detector_unavailable";

export type DetectorState = "loading" | "ready" | "unavailable";

export type NormalizedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PoseLandmark = {
  x: number;
  y: number;
  z: number;
  visibility: number;
};

export type VisibleRegions = {
  head: boolean;
  torso: boolean;
  legs: boolean;
  feet: boolean;
};

export type FrameQualityMetrics = {
  poseConfidence: number;
  landmarkVisibility: number;
  personFrameCoverage: number;
  sharpness: number;
  brightness: number;
  motion: number;
};

export type OutfitDetectionResult = {
  capturedAt: number;
  observedStatus: OutfitFrameStatus;
  stableStatus: OutfitFrameStatus;
  scoreable: boolean;
  personBox: NormalizedRect | null;
  cropBox: NormalizedRect | null;
  landmarks: PoseLandmark[];
  visibleRegions: VisibleRegions;
  quality: FrameQualityMetrics;
  processingMs: number;
};

export type CandidateFrame = {
  capturedAt: number;
  crop: ImageBitmap;
  quality: FrameQualityMetrics;
  visibleRegions: VisibleRegions;
};

export type FrameObservation = Omit<
  OutfitDetectionResult,
  "stableStatus" | "scoreable" | "processingMs"
>;

export type WorkerRequest =
  | { type: "init"; modelUrl: string; wasmUrl: string }
  | {
      type: "analyse";
      requestId: number;
      capturedAt: number;
      frame: ImageBitmap;
    }
  | { type: "reset" };

export type WorkerResponse =
  | { type: "ready" }
  | {
      type: "result";
      requestId: number;
      result: OutfitDetectionResult;
      candidate?: ImageBitmap;
    }
  | { type: "error"; message: string };

export type OutfitDetectionController = {
  result: OutfitDetectionResult | null;
  detectorState: DetectorState;
  captureCurrentCandidate(): Promise<CandidateFrame | null>;
  consumeBestCandidate(): CandidateFrame | null;
};
