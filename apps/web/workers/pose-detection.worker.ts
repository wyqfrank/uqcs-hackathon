import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { CV_CONFIG } from "@/lib/cv/config";
import { boundsFromLandmarks, rectToPixels } from "@/lib/cv/crop";
import {
  classifyFrame,
  measureImageQuality,
  qualifyingPoses,
} from "@/lib/cv/frame-quality";
import { calculateLandmarkMotion } from "@/lib/cv/motion";
import { DetectionStabilizer } from "@/lib/cv/temporal";
import type {
  PoseLandmark,
  NormalizedRect,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/cv/types";

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
};

const scope = globalThis as unknown as WorkerScope;
const stabilizer = new DetectionStabilizer();
let detector: PoseLandmarker | null = null;
let previousPose: PoseLandmark[] | null = null;
let previousPoseAt = 0;

function post(message: WorkerResponse, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

async function initialise(modelUrl: string, wasmUrl: string) {
  detector?.close();
  const fileset = await FilesetResolver.forVisionTasks(wasmUrl);
  detector = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: modelUrl, delegate: "CPU" },
    runningMode: "VIDEO",
    numPoses: 2,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });
  stabilizer.reset();
  previousPose = null;
  previousPoseAt = 0;
}

function sampleQuality(frame: ImageBitmap, rect: ReturnType<typeof rectToPixels> | null) {
  const source = rect ?? { x: 0, y: 0, width: frame.width, height: frame.height };
  const scale = Math.min(1, 160 / Math.max(source.width, source.height));
  const width = Math.max(3, Math.round(source.width * scale));
  const height = Math.max(3, Math.round(source.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) return { brightness: 0, sharpness: 0 };
  context.drawImage(
    frame,
    source.x,
    source.y,
    source.width,
    source.height,
    0,
    0,
    width,
    height,
  );
  return measureImageQuality(context.getImageData(0, 0, width, height));
}

function createCandidate(frame: ImageBitmap, cropBox: NormalizedRect) {
  const source = rectToPixels(cropBox, frame.width, frame.height);
  const canvas = new OffscreenCanvas(source.width, source.height);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  context.drawImage(
    frame,
    source.x,
    source.y,
    source.width,
    source.height,
    0,
    0,
    source.width,
    source.height,
  );
  return canvas.transferToImageBitmap();
}

function analyse(requestId: number, capturedAt: number, frame: ImageBitmap) {
  if (!detector) throw new Error("Pose detector is not initialized.");
  const startedAt = performance.now();

  try {
    const detection = detector.detectForVideo(frame, capturedAt);
    const poses = detection.landmarks.map((pose) =>
      pose.map(({ x, y, z, visibility }) => ({ x, y, z, visibility })),
    );
    const qualified = qualifyingPoses(poses);
    const primaryPose = qualified.length === 1 ? qualified[0] : null;
    const elapsedMs = primaryPose && previousPose ? capturedAt - previousPoseAt : 0;
    const motion = primaryPose
      ? calculateLandmarkMotion(previousPose, primaryPose, elapsedMs)
      : 0;

    const roughBox = primaryPose ? boundsFromLandmarks(primaryPose) : null;
    const roughBounds = roughBox
      ? rectToPixels(roughBox, frame.width, frame.height)
      : null;
    const imageQuality = sampleQuality(frame, roughBounds);
    const observation = classifyFrame(capturedAt, poses, imageQuality, motion);
    const result = stabilizer.update(observation);

    if (primaryPose) {
      previousPose = primaryPose;
      previousPoseAt = capturedAt;
    } else if (capturedAt - previousPoseAt > CV_CONFIG.maximumResultAgeMs) {
      previousPose = null;
    }

    const candidate =
      result.scoreable && result.cropBox ? createCandidate(frame, result.cropBox) : null;
    result.processingMs = performance.now() - startedAt;
    post(
      { type: "result", requestId, result, ...(candidate ? { candidate } : {}) },
      candidate ? [candidate] : [],
    );
  } finally {
    frame.close();
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      void initialise(message.modelUrl, message.wasmUrl)
        .then(() => post({ type: "ready" }))
        .catch((error: unknown) =>
          post({ type: "error", message: error instanceof Error ? error.message : String(error) }),
        );
      return;
    }
    if (message.type === "reset") {
      stabilizer.reset();
      previousPose = null;
      previousPoseAt = 0;
      return;
    }
    analyse(message.requestId, message.capturedAt, message.frame);
  } catch (error) {
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
