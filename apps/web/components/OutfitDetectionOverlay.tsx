import type { RefObject } from "react";
import { mirrorRect } from "@/lib/cv/crop";
import { guidanceLabel } from "@/lib/cv/status";
import type { DetectorState, OutfitDetectionResult } from "@/lib/cv/types";

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

