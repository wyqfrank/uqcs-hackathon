"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { captureCurrentVideoCrop, encodeAndCloseImageBitmap } from "@/lib/captureFrame";
import {
  fetchFitScoreHealth,
  postFitScore,
  smoothScore,
  WHOLE_FRAME,
  type LiveFitScore,
} from "@/lib/fitScore";

export type LiveFitScoreState =
  | "idle"
  | "checking"
  | "unavailable"
  | "scoring"
  | "error";

export type FitScoreSample = {
  score: number;
  percentile: number;
  raw: number;
  latencyMs: number;
  at: number;
};

const HISTORY_LENGTH = 40;

/**
 * Scores the local video at roughly 1 FPS.
 *
 * One request in flight at a time and no queue, matching the garment path: if
 * a score is still coming back when the next tick fires, that tick is skipped
 * rather than stacked. A queued frame would be showing the player a score for
 * a pose they have already left.
 */
export function useLiveFitScore(
  video: React.RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  intervalMs = 1000,
) {
  const [state, setState] = useState<LiveFitScoreState>("idle");
  const [latest, setLatest] = useState<LiveFitScore | null>(null);
  const [smoothed, setSmoothed] = useState<number | null>(null);
  const [history, setHistory] = useState<FitScoreSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modelVersion, setModelVersion] = useState<string | null>(null);

  const inFlight = useRef(false);
  const smoothedRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    smoothedRef.current = null;
    setSmoothed(null);
    setLatest(null);
    setHistory([]);
    setError(null);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState("idle");
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (!active || inFlight.current) return;
      const element = video.current;
      if (!element || element.readyState < 2) return;

      inFlight.current = true;
      try {
        const bitmap = await captureCurrentVideoCrop(element, WHOLE_FRAME);
        if (!bitmap) return;
        const frame = await encodeAndCloseImageBitmap(bitmap, {
          maxWidth: 640,
          quality: 0.82,
          format: "image/webp",
        });
        if (!frame || !active) return;

        const result = await postFitScore(frame);
        if (!active) return;

        smoothedRef.current = smoothScore(smoothedRef.current, result.score);
        setSmoothed(smoothedRef.current);
        setLatest(result);
        setModelVersion(result.modelVersion);
        setHistory((previous) =>
          [
            ...previous,
            {
              score: result.score,
              percentile: result.percentile,
              raw: result.raw,
              latencyMs: result.latencyMs,
              at: Date.now(),
            },
          ].slice(-HISTORY_LENGTH),
        );
        setError(null);
        setState("scoring");
      } catch (caughtError) {
        if (!active) return;
        setError(caughtError instanceof Error ? caughtError.message : "Scoring failed.");
        setState("error");
      } finally {
        inFlight.current = false;
      }
    };

    const start = async () => {
      setState("checking");
      const health = await fetchFitScoreHealth();
      if (!active) return;
      setModelVersion(health.modelVersion);
      if (!health.ready) {
        setError(health.reason ?? "The live ranker is not loaded.");
        setState("unavailable");
        return;
      }
      setError(null);
      setState("scoring");
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
    };

    void start();
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [enabled, intervalMs, video]);

  return { state, latest, smoothed, history, error, modelVersion, reset };
}
