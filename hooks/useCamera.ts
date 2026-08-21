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
