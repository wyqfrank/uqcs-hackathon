"use client";

import { useEffect, useState } from "react";
import type { Socket } from "socket.io-client";
import { encodeAndCloseImageBitmap } from "@/lib/captureFrame";
import type { OutfitDetectionController } from "@/lib/cv/types";
import {
  garmentPerceptionForRole,
  type GarmentCategory,
  type GarmentOverlay,
  type GarmentPairResult,
} from "@/lib/garmentPerception";
import type { RoomRole } from "@/lib/signaling";

export type { GarmentCategory } from "@/lib/garmentPerception";

type GarmentFrameRequest = {
  battleId: string;
  requestId: string;
  deadlineAt: number;
};

type EventAcknowledgement =
  | { ok: true }
  | { ok: false; error: string; paused?: boolean };

export function useGarmentPerception(
  roomId: string,
  role: RoomRole,
  socket: Socket | null,
  detection: OutfitDetectionController,
  enabled: boolean,
) {
  const [localCategories, setLocalCategories] = useState<GarmentCategory[]>([]);
  const [remoteCategories, setRemoteCategories] = useState<GarmentCategory[]>([]);
  const [localOverlay, setLocalOverlay] = useState<GarmentOverlay | null>(null);
  const [remoteOverlay, setRemoteOverlay] = useState<GarmentOverlay | null>(null);
  const [state, setState] = useState<"idle" | "sampling" | "ready" | "unavailable">(
    "idle",
  );
  const consumeBestCandidate = detection.consumeBestCandidate;

  useEffect(() => {
    if (!socket) return;
    let active = true;

    const onFrameRequest = async (event: GarmentFrameRequest) => {
      if (!enabled || event.battleId !== roomId || Date.now() > event.deadlineAt) return;
      const candidate = consumeBestCandidate();
      if (!candidate) {
        socket.emit("garment-frame-unavailable", {
          requestId: event.requestId,
          reason: "no_stable_frame",
        });
        return;
      }

      setState("sampling");
      const capturedAtEpochMs = performance.timeOrigin + candidate.capturedAt;
      const blob = await encodeAndCloseImageBitmap(candidate.crop, {
        maxWidth: 640,
        quality: 0.82,
        format: "image/webp",
      });
      if (!active || !enabled) return;
      if (!blob) {
        socket.emit("garment-frame-unavailable", {
          requestId: event.requestId,
          reason: "encoding_failed",
        });
        return;
      }

      socket.emit(
        "garment-frame",
        {
          requestId: event.requestId,
          sampleId: crypto.randomUUID(),
          capturedAtEpochMs,
          mimeType: blob.type,
          cropBox: candidate.cropBox,
          image: await blob.arrayBuffer(),
        },
        (acknowledgement: EventAcknowledgement) => {
          if (!active || acknowledgement.ok || acknowledgement.paused) return;
          setState("unavailable");
        },
      );
    };

    const onResult = (result: GarmentPairResult) => {
      if (!active || result.battleId !== roomId) return;
      const perception = garmentPerceptionForRole(result, role);
      setLocalCategories(perception.local.categories);
      setRemoteCategories(perception.remote.categories);
      setLocalOverlay(perception.local.overlay);
      setRemoteOverlay(perception.remote.overlay);
      setState("ready");
    };

    const onUnavailable = (event: { battleId: string }) => {
      if (active && event.battleId === roomId) setState("unavailable");
    };

    socket.on("garment-frame-request", onFrameRequest);
    socket.on("garment-result", onResult);
    socket.on("garment-unavailable", onUnavailable);
    return () => {
      active = false;
      socket.off("garment-frame-request", onFrameRequest);
      socket.off("garment-result", onResult);
      socket.off("garment-unavailable", onUnavailable);
    };
  }, [consumeBestCandidate, enabled, role, roomId, socket]);

  return { state, localCategories, remoteCategories, localOverlay, remoteOverlay };
}
