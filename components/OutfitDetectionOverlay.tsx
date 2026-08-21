import type { RefObject } from "react";
import { mirrorRect } from "@/lib/cv/crop";
import type {
  DetectorState,
  OutfitDetectionResult,
  OutfitFrameStatus,
} from "@/lib/cv/types";

const STATUS_LABELS: Record<Exclude<OutfitFrameStatus, "valid">, string> = {
  no_person: "STEP INTO FRAME",
  multiple_people: "ONLY ONE PERSON",
  partial_outfit: "SHOW MORE OF YOUR FIT",
  too_close: "STEP BACK",
  too_far: "MOVE CLOSER",
  low_light: "MORE LIGHT NEEDED",
  blurred: "HOLD STILL",
  moving_too_fast: "HOLD STILL",
  detector_unavailable: "DETECTOR UNAVAILABLE",
};

function guidanceLabel(
  state: DetectorState,
  result: OutfitDetectionResult | null,
) {
  if (state === "loading") return "LOADING FIT DETECTOR";
  if (state === "unavailable" || !result) return "DETECTOR UNAVAILABLE";
  if (result.observedStatus !== "valid") return STATUS_LABELS[result.observedStatus];
  return result.scoreable ? "FIT READY" : "HOLD STILL";
}

export function OutfitDetectionOverlay({
  videoRef,
  detectorState,
  result,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  detectorState: DetectorState;
  result: OutfitDetectionResult | null;
}) {
  const debug = process.env.NEXT_PUBLIC_CV_DEBUG === "1";
  const sourceWidth = videoRef.current?.videoWidth || 16;
  const sourceHeight = videoRef.current?.videoHeight || 9;
  const mirroredCrop = result?.cropBox ? mirrorRect(result.cropBox) : null;
  const label = guidanceLabel(detectorState, result);
  const ready = Boolean(result?.scoreable);

  return (
    <div className={`detection-overlay ${ready ? "is-ready" : ""}`}>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${sourceWidth} ${sourceHeight}`}
        preserveAspectRatio="xMidYMid slice"
      >
        {mirroredCrop && (
          <rect
            className="detection-crop"
            x={mirroredCrop.x * sourceWidth}
            y={mirroredCrop.y * sourceHeight}
            width={mirroredCrop.width * sourceWidth}
            height={mirroredCrop.height * sourceHeight}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {debug && result?.landmarks.map((landmark, index) => (
          <circle
            className="detection-landmark"
            key={index}
            cx={(1 - landmark.x) * sourceWidth}
            cy={landmark.y * sourceHeight}
            r={2.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <span className="detection-guidance" aria-live="polite">{label}</span>
      {debug && result && (
        <output className="detection-debug">
          <span>OBS {result.observedStatus}</span>
          <span>STABLE {result.stableStatus}</span>
          <span>{result.processingMs.toFixed(0)} MS</span>
          <span>VIS {(result.quality.landmarkVisibility * 100).toFixed(0)}%</span>
          <span>FEET {result.visibleRegions.feet ? "YES" : "NO"}</span>
        </output>
      )}
    </div>
  );
}

