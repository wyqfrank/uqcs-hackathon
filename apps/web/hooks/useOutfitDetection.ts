"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { CandidateFrameBuffer } from "@/lib/cv/candidates";
import { CV_CONFIG } from "@/lib/cv/config";
import { detectorUnavailableResult } from "@/lib/cv/frame-quality";
import type {
  DetectorState,
  OutfitDetectionController,
  OutfitDetectionResult,
  WorkerRequest,
  WorkerResponse,
} from "@/lib/cv/types";

const MODEL_URL = "/mediapipe/models/pose_landmarker_lite.task";
const WASM_URL = "/mediapipe/wasm";

export function useOutfitDetection(
  videoRef: RefObject<HTMLVideoElement | null>,
  enabled: boolean,
): OutfitDetectionController {
  const [result, setResult] = useState<OutfitDetectionResult | null>(null);
  const [detectorState, setDetectorState] = useState<DetectorState>("loading");
  const candidatesRef = useRef(new CandidateFrameBuffer());

  useEffect(() => {
    const candidates = candidatesRef.current;
    if (!enabled) {
      candidates.clear();
      setResult(null);
      setDetectorState("loading");
      return;
    }

    const video = videoRef.current;
    if (
      !video ||
      typeof Worker === "undefined" ||
      typeof createImageBitmap === "undefined" ||
      typeof video.requestVideoFrameCallback !== "function"
    ) {
      setDetectorState("unavailable");
      setResult(detectorUnavailableResult(performance.now()));
      return;
    }

    const worker = new Worker(
      new URL("../workers/pose-detection.worker.ts", import.meta.url),
      { type: "module", name: "mog-pose-detection" },
    );
    let active = true;
    let ready = false;
    let inFlight = false;
    let callbackId: number | null = null;
    let requestId = 0;
    let lastSubmittedAt = Number.NEGATIVE_INFINITY;

    const markUnavailable = () => {
      if (!active) return;
      ready = false;
      inFlight = false;
      setDetectorState("unavailable");
      setResult(detectorUnavailableResult(performance.now()));
    };

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (!active) {
        if (event.data.type === "result") event.data.candidate?.close();
        return;
      }
      const message = event.data;
      if (message.type === "ready") {
        ready = true;
        setDetectorState("ready");
        return;
      }
      if (message.type === "error") {
        markUnavailable();
        return;
      }

      inFlight = false;
      setResult(message.result);
      if (!message.candidate) return;
      if (performance.now() - message.result.capturedAt > CV_CONFIG.maximumResultAgeMs) {
        message.candidate.close();
        return;
      }
      candidates.add({
        capturedAt: message.result.capturedAt,
        crop: message.candidate,
        quality: message.result.quality,
        visibleRegions: message.result.visibleRegions,
      }, performance.now());
    };
    worker.onerror = markUnavailable;

    const submitFrame = async (capturedAt: number) => {
      if (!active || !ready || inFlight || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return;
      }
      if (capturedAt - lastSubmittedAt < CV_CONFIG.analysisIntervalMs) return;

      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      if (!sourceWidth || !sourceHeight) return;
      const scale = Math.min(1, CV_CONFIG.maxFrameEdge / Math.max(sourceWidth, sourceHeight));
      const resizeWidth = Math.max(1, Math.round(sourceWidth * scale));
      const resizeHeight = Math.max(1, Math.round(sourceHeight * scale));

      inFlight = true;
      lastSubmittedAt = capturedAt;
      let frame: ImageBitmap | null = null;
      try {
        frame = await createImageBitmap(video, {
          resizeWidth,
          resizeHeight,
          resizeQuality: "high",
        });
        if (!active) {
          frame.close();
          return;
        }
        const message: WorkerRequest = {
          type: "analyse",
          requestId: ++requestId,
          capturedAt,
          frame,
        };
        worker.postMessage(message, [frame]);
        frame = null;
      } catch {
        frame?.close();
        markUnavailable();
      } finally {
        if (frame) inFlight = false;
      }
    };

    const scheduleNextFrame = () => {
      callbackId = video.requestVideoFrameCallback((now) => {
        scheduleNextFrame();
        void submitFrame(now);
      });
    };

    const initMessage: WorkerRequest = {
      type: "init",
      modelUrl: MODEL_URL,
      wasmUrl: WASM_URL,
    };
    worker.postMessage(initMessage);
    scheduleNextFrame();

    return () => {
      active = false;
      if (callbackId !== null) video.cancelVideoFrameCallback(callbackId);
      worker.terminate();
      candidates.clear();
    };
  }, [enabled, videoRef]);

  const consumeBestCandidate = useCallback(
    () => candidatesRef.current.consumeBest(performance.now()),
    [],
  );

  return { result, detectorState, consumeBestCandidate };
}

