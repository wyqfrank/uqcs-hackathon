import { CV_CONFIG } from "./config";
import type { CandidateFrame, FrameQualityMetrics } from "./types";

const brightnessFitness = (brightness: number) =>
  1 - Math.min(1, Math.abs(brightness - 0.5) / 0.5);

export function candidateQualityScore(quality: FrameQualityMetrics): number {
  const motionFitness = 1 - Math.min(1, quality.motion / CV_CONFIG.rapidMotionThreshold);
  return (
    quality.landmarkVisibility * 0.45 +
    quality.sharpness * 0.3 +
    brightnessFitness(quality.brightness) * 0.15 +
    motionFitness * 0.1
  );
}

export class CandidateFrameBuffer {
  private candidates: CandidateFrame[] = [];

  add(candidate: CandidateFrame, now = candidate.capturedAt) {
    this.removeExpired(now);
    this.candidates.push(candidate);
    while (this.candidates.length > CV_CONFIG.candidateLimit) {
      this.candidates.shift()?.crop.close();
    }
  }

  consumeBest(now: number): CandidateFrame | null {
    this.removeExpired(now);
    if (this.candidates.length === 0) return null;

    let bestIndex = 0;
    for (let index = 1; index < this.candidates.length; index += 1) {
      const candidate = this.candidates[index];
      const best = this.candidates[bestIndex];
      const scoreDifference =
        candidateQualityScore(candidate.quality) - candidateQualityScore(best.quality);
      if (scoreDifference > 0 || (scoreDifference === 0 && candidate.capturedAt > best.capturedAt)) {
        bestIndex = index;
      }
    }

    return this.candidates.splice(bestIndex, 1)[0];
  }

  clear() {
    for (const candidate of this.candidates) candidate.crop.close();
    this.candidates = [];
  }

  get size() {
    return this.candidates.length;
  }

  private removeExpired(now: number) {
    const retained: CandidateFrame[] = [];
    for (const candidate of this.candidates) {
      if (now - candidate.capturedAt > CV_CONFIG.maximumResultAgeMs) {
        candidate.crop.close();
      } else {
        retained.push(candidate);
      }
    }
    this.candidates = retained;
  }
}

