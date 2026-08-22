"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeAndCloseImageBitmap } from "@/lib/captureFrame";
import { guidanceLabel } from "@/lib/cv/status";
import type { OutfitDetectionController } from "@/lib/cv/types";
import {
  fetchFitScoreHealth,
  postFitScore,
  smoothScore,
  type LiveFitScore,
} from "@/lib/fitScore";

export type LiveFitScoreState =
  | "idle"
  | "checking"
  | "unavailable"
  | "waiting_for_frame"
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
 * Scores the local player at roughly 1 FPS.
 *
 * Two things this must not do, both learned the hard way:
 *
 * **Score the whole frame.** The model was trained on person-framed full-body
 * photos. A raw webcam view is mostly room, and letterboxing it to a square
 * shrinks the person further, so the embedding ends up describing the wall.
 * Frames go through the same `cropBox` the garment path and finalisation use.
 *
 * **Score a player it cannot see.** The model has no concept of bad framing —
 * fed a half-visible person it returns a confident number that reads as a
 * verdict on the outfit. When the detector says the frame is not scoreable
 * there is no score, rather than a low one: "your fit is bad" and "I cannot see
 * your fit" are different statements.
 *
 * One request in flight at a time and no queue, matching the garment path: a
 * queued frame would be showing a score for a pose the player has left.
 */
export function useLiveFitScore(
  detection: OutfitDetectionController,
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

  // Read through refs so the polling effect does not restart on every new
  // detector result, which arrives many times a second.
  const detectionRef = useRef(detection);
  detectionRef.current = detection;

  const scoreable =
    detection.detectorState === "ready" && detection.result?.scoreable === true;
  const framingLabel = guidanceLabel(detection.detectorState, detection.result);
  const scoreableRef = useRef(scoreable);
  scoreableRef.current = scoreable;

  const reset = useCallback(() => {
    smoothedRef.current = null;
    setSmoothed(null);
    setLatest(null);
    setHistory([]);
    setError(null);
  }, []);

  // Drop the displayed score the moment the player stops being visible, so a
  // stale number cannot sit on screen looking like a live reading.
  useEffect(() => {
    if (enabled && !scoreable) {
      smoothedRef.current = null;
      setSmoothed(null);
      setLatest(null);
    }
  }, [enabled, scoreable]);

  useEffect(() => {
    if (!enabled) {
      setState("idle");
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (!active || inFlight.current) return;
      if (!scoreableRef.current) {
        setState("waiting_for_frame");
        return;
      }

      inFlight.current = true;
      try {
        // Non-destructive: `consumeBestCandidate` would steal frames from the
        // garment path, which drains the same buffer.
        const candidate = await detectionRef.current.captureCurrentCandidate();
        if (!candidate || !active) return;

        const frame = await encodeAndCloseImageBitmap(candidate.crop, {
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
      setState("waiting_for_frame");
      void tick();
      timer = setInterval(() => void tick(), intervalMs);
    };

    void start();
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [enabled, intervalMs]);

  return {
    state,
    latest,
    smoothed,
    history,
    error,
    modelVersion,
    scoreable,
    framingLabel,
    reset,
  };
}
