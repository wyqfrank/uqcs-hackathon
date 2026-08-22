import type { RefObject } from "react";
import { mirrorRect, projectRectIntoRect } from "../lib/cv/crop";
import {
  GARMENT_LABELS,
  type GarmentOverlay,
} from "../lib/garmentPerception";

export function GarmentDetectionOverlay({
  videoRef,
  overlay,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  overlay: GarmentOverlay | null;
}) {
  if (!overlay?.detections.length) return null;
  const sourceWidth = videoRef.current?.videoWidth || 16;
  const sourceHeight = videoRef.current?.videoHeight || 9;

  return (
    <svg
      className="garment-detection-overlay"
      viewBox={`0 0 ${sourceWidth} ${sourceHeight}`}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="Detected garment bounding boxes"
    >
      <title>Detected garment bounding boxes</title>
      {overlay.detections.map((detection, index) => {
        const box = mirrorRect(projectRectIntoRect(detection.box, overlay.cropBox));
        const x = box.x * sourceWidth;
        const y = box.y * sourceHeight;
        return (
          <g key={`${detection.category}-${index}`}>
            <rect
              className="garment-detection-box"
              x={x}
              y={y}
              width={box.width * sourceWidth}
              height={box.height * sourceHeight}
              vectorEffect="non-scaling-stroke"
            />
            <text
              className="garment-detection-label"
              x={x + 5}
              y={Math.max(22, y + 22)}
            >
              {GARMENT_LABELS[detection.category]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
