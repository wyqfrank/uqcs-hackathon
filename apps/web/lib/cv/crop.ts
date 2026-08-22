import { CV_CONFIG } from "./config";
import type { NormalizedRect, PoseLandmark } from "./types";

const clamp = (value: number, minimum = 0, maximum = 1) =>
  Math.min(maximum, Math.max(minimum, value));

export function boundsFromLandmarks(
  landmarks: PoseLandmark[],
  minimumVisibility = CV_CONFIG.secondaryVisibilityThreshold,
): NormalizedRect | null {
  const visible = landmarks.filter(
    (landmark) =>
      landmark.visibility >= minimumVisibility &&
      Number.isFinite(landmark.x) &&
      Number.isFinite(landmark.y),
  );
  if (visible.length === 0) return null;

  const xs = visible.map(({ x }) => clamp(x));
  const ys = visible.map(({ y }) => clamp(y));
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function expandAndClampRect(
  rect: NormalizedRect,
  padding = CV_CONFIG.cropPadding,
): NormalizedRect {
  const horizontalPadding = rect.width * padding;
  const verticalPadding = rect.height * padding;
  const left = clamp(rect.x - horizontalPadding);
  const top = clamp(rect.y - verticalPadding);
  const right = clamp(rect.x + rect.width + horizontalPadding);
  const bottom = clamp(rect.y + rect.height + verticalPadding);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function mirrorRect(rect: NormalizedRect): NormalizedRect {
  return { ...rect, x: 1 - rect.x - rect.width };
}

export function rectToPixels(
  rect: NormalizedRect,
  sourceWidth: number,
  sourceHeight: number,
) {
  const ceilPixel = (value: number) => Math.ceil(value - 1e-9);
  const x = Math.max(0, Math.floor(rect.x * sourceWidth));
  const y = Math.max(0, Math.floor(rect.y * sourceHeight));
  const right = Math.min(sourceWidth, ceilPixel((rect.x + rect.width) * sourceWidth));
  const bottom = Math.min(sourceHeight, ceilPixel((rect.y + rect.height) * sourceHeight));

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}
