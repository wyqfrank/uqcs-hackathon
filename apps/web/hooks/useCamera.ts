"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CameraStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "stopped"
  | "denied"
  | "unavailable"
  | "error";

const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
    facingMode: "user",
  },
  audio: false,
};

/** Ultra-wide, so a whole outfit fits in frame without stepping back. */
export const TARGET_ZOOM = 0.5;

/** `zoom` is a real MediaTrack property but is absent from lib.dom. */
type ZoomRange = { min?: number; max?: number };
type ZoomCapabilities = MediaTrackCapabilities & { zoom?: ZoomRange };
type ZoomConstraint = MediaTrackConstraintSet & { zoom?: number };

/**
 * Picks the zoom to request from what the camera actually offers.
 *
 * A built-in laptop camera has no ultra-wide lens and reports a minimum of 1,
 * so clamping rather than failing gives the widest framing that hardware can
 * manage. Returns null when the camera does not expose zoom at all.
 */
export function resolveZoom(range: ZoomRange | undefined, target = TARGET_ZOOM): number | null {
  if (!range || typeof range.min !== "number" || typeof range.max !== "number") return null;
  if (range.max < range.min) return null;
  return Math.min(Math.max(target, range.min), range.max);
}

/**
 * Applied after the stream exists rather than as a getUserMedia constraint:
 * requesting an unsupported zoom up front fails the whole camera request.
 */
async function applyWideZoom(stream: MediaStream): Promise<void> {
  for (const track of stream.getVideoTracks()) {
    const capabilities = track.getCapabilities?.() as ZoomCapabilities | undefined;
    const zoom = resolveZoom(capabilities?.zoom);
    if (zoom === null) continue;
    try {
      await track.applyConstraints({ advanced: [{ zoom } as ZoomConstraint] });
    } catch {
      // Some drivers advertise zoom and then refuse to set it. The feed is
      // still usable, so carry on at the default framing.
    }
  }
}

export function useCamera(autoStart = true) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const pendingRef = useRef<Promise<MediaStream> | null>(null);
  const keepStreamRef = useRef(true);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopCamera = useCallback(() => {
    keepStreamRef.current = false;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
    setStatus("stopped");
  }, []);

  const startCamera = useCallback(async () => {
    keepStreamRef.current = true;
    const currentStream = streamRef.current;
    if (currentStream?.getVideoTracks().some((track) => track.readyState === "live")) {
      setStream(currentStream);
      setStatus("ready");
      return currentStream;
    }

    setStatus("requesting");
    setError(null);

    try {
      if (!pendingRef.current) {
        pendingRef.current = navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS);
      }
      const nextStream = await pendingRef.current;
      pendingRef.current = null;

      if (!keepStreamRef.current) {
        nextStream.getTracks().forEach((track) => track.stop());
        return null;
      }

      await applyWideZoom(nextStream);

      streamRef.current = nextStream;
      setStream(nextStream);
      setStatus("ready");
      return nextStream;
    } catch (caughtError) {
      pendingRef.current = null;
      const permissionDenied = caughtError instanceof DOMException && caughtError.name === "NotAllowedError";
      const message = permissionDenied
        ? "Camera permission was denied. Allow access in your browser and try again."
        : "No camera is available. Check that it is connected and not in use.";
      setError(message);
      setStatus(permissionDenied ? "denied" : "unavailable");
      return null;
    }
  }, []);

  useEffect(() => {
    keepStreamRef.current = true;
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    if (autoStart) void startCamera();

    return () => {
      keepStreamRef.current = false;
      // The deferred cleanup survives React Strict Mode's setup/cleanup probe.
      stopTimerRef.current = setTimeout(() => {
        if (!keepStreamRef.current) {
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
      }, 0);
    };
  }, [autoStart, startCamera]);

  return { stream, status, error, startCamera, stopCamera };
}
