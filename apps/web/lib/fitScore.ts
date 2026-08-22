import type { NormalizedRect } from "./cv/types";

/** The whole frame. Live scoring has no person box of its own to work from. */
export const WHOLE_FRAME: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

export type LiveFitScore = {
  /** Display score, already mapped into the configured band. */
  score: number;
  /** Rank against the training pool, 0..1. The honest quantity. */
  percentile: number;
  /** The head's own output. No meaningful scale — exposed for diagnostics. */
  raw: number;
  modelVersion: string;
  latencyMs: number;
};

export type FitScoreHealth = {
  ready: boolean;
  modelVersion: string;
  reason?: string | null;
};

export class FitScoreError extends Error {}

export async function postFitScore(
  frame: Blob,
  signal?: AbortSignal,
): Promise<LiveFitScore> {
  const body = new FormData();
  body.append("image", frame, "frame.webp");

  const response = await fetch("/api/fit-score", { method: "POST", body, signal });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new FitScoreError(
      (payload && typeof payload.error === "string" && payload.error)
      || `Scoring failed (${response.status}).`,
    );
  }
  return payload as LiveFitScore;
}

export async function fetchFitScoreHealth(): Promise<FitScoreHealth> {
  const response = await fetch("/api/fit-score", { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  return (
    (payload as FitScoreHealth | null)
    ?? { ready: false, modelVersion: "unavailable", reason: "No response." }
  );
}

/**
 * Exponential moving average over the live score.
 *
 * A single frame at 1 FPS is a noisy read of a person who is moving, and an
 * unsmoothed number visibly jitters. Smoothing is display-only and must never
 * be the thing measured: it hides exactly the frame-to-frame instability that
 * tells you whether the model works on webcam input at all, which is why the
 * hook keeps the raw samples alongside it.
 */
export function smoothScore(previous: number | null, next: number, alpha = 0.35) {
  if (previous === null) return next;
  return previous + alpha * (next - previous);
}
