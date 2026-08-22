import type { PoseLandmark } from "./types";

const TRACKED_LANDMARKS = [11, 12, 23, 24, 25, 26];

const midpoint = (left: PoseLandmark, right: PoseLandmark) => ({
  x: (left.x + right.x) / 2,
  y: (left.y + right.y) / 2,
});

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

export function calculateLandmarkMotion(
  previous: PoseLandmark[] | null,
  current: PoseLandmark[],
  elapsedMs: number,
): number {
  if (!previous || elapsedMs <= 0 || previous.length < 27 || current.length < 27) {
    return 0;
  }

  const shoulderMidpoint = midpoint(current[11], current[12]);
  const hipMidpoint = midpoint(current[23], current[24]);
  const torsoLength = Math.max(0.05, distance(shoulderMidpoint, hipMidpoint));

  const displacements = TRACKED_LANDMARKS.map((index) =>
    distance(previous[index], current[index]),
  );
  const meanDisplacement =
    displacements.reduce((total, value) => total + value, 0) / displacements.length;

  return meanDisplacement / torsoLength / (elapsedMs / 1000);
}

