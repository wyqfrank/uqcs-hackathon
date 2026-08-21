"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { captureVideoFrame } from "@/lib/captureFrame";
import { inferFrame, smoothScore } from "@/lib/scoring";

export function useInference(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
  frozen: boolean,
  intervalMs = 250,
) {
  const [score, setScore] = useState<number | null>(null);
  const [isAnalysing, setIsAnalysing] = useState(false);
  const inferenceRunningRef = useRef(false);

  useEffect(() => {
    if (!enabled || frozen) {
      setIsAnalysing(false);
      return;
    }

    let active = true;
    const runInference = async () => {
      // Backpressure: one in-flight inference only; timer ticks are simply skipped.
      if (inferenceRunningRef.current || !videoRef.current) return;
      inferenceRunningRef.current = true;
      setIsAnalysing(true);

      try {
        const frame = await captureVideoFrame(videoRef.current);
        if (!frame) return;
        const result = await inferFrame(frame);
        if (active) setScore((previous) => smoothScore(previous, result.score));
      } finally {
        inferenceRunningRef.current = false;
      }
    };

    void runInference();
    const timer = window.setInterval(() => void runInference(), intervalMs);
    return () => {
      active = false;
      window.clearInterval(timer);
      setIsAnalysing(false);
    };
  }, [enabled, frozen, intervalMs, videoRef]);

  return { score, isAnalysing };
}
