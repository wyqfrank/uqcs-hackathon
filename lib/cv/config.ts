export const CV_CONFIG = {
  analysisIntervalMs: 100,
  maxFrameEdge: 640,
  poseVisibilityThreshold: 0.5,
  secondaryVisibilityThreshold: 0.25,
  minimumPersonHeight: 0.4,
  maximumPersonHeight: 0.92,
  minimumBorderClearance: 0.03,
  cropPadding: 0.15,
  lowLightThreshold: 0.16,
  blurThreshold: 0.12,
  rapidMotionThreshold: 1.5,
  validObservationsRequired: 2,
  invalidObservationsRequired: 3,
  maximumResultAgeMs: 300,
  candidateLimit: 5,
} as const;

