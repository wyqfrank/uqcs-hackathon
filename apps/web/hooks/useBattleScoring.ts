"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { encodeAndCloseImageBitmap } from "@/lib/captureFrame";
import type { OutfitDetectionController } from "@/lib/cv/types";
import {
  isCurrentScoreResult,
  type BattleScoringState,
  type ScoreResult,
} from "@/lib/scoring";

type FinalisationStarted = {
  battleId: string;
  finalisationId: string;
  deadlineAt: number;
};

type FinalisationAnalysing = {
  battleId: string;
  finalisationId: string;
  pairId: string;
};

type EventAcknowledgement = { ok: true } | { ok: false; error: string };
type FinaliseAcknowledgement =
  | { ok: true; finalisationId: string; locked: boolean }
  | { ok: false; error: string };

const CANDIDATE_POLL_MS = 80;

const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export function useBattleScoring(
  roomId: string,
  socket: Socket | null,
  detection: OutfitDetectionController,
) {
  const [state, setState] = useState<BattleScoringState>({ phase: "ready" });
  const [requestError, setRequestError] = useState<string | null>(null);
  const activeFinalisationRef = useRef<string | null>(null);
  const submittedFinalisationsRef = useRef(new Set<string>());
  const consumeBestCandidate = detection.consumeBestCandidate;
  const detectorStateRef = useRef(detection.detectorState);
  detectorStateRef.current = detection.detectorState;

  useEffect(() => {
    if (!socket) return;
    let active = true;

    const submitNewestCandidate = async (event: FinalisationStarted) => {
      if (submittedFinalisationsRef.current.has(event.finalisationId)) return;
      submittedFinalisationsRef.current.add(event.finalisationId);

      let candidate = consumeBestCandidate();
      while (!candidate && active && Date.now() < event.deadlineAt) {
        await wait(CANDIDATE_POLL_MS);
        candidate = consumeBestCandidate();
      }
      if (!active || activeFinalisationRef.current !== event.finalisationId) {
        candidate?.crop.close();
        return;
      }
      if (!candidate) {
        socket.emit("score-frame-unavailable", {
          finalisationId: event.finalisationId,
          reason: detectorStateRef.current === "unavailable" ? "detector_unavailable" : "no_stable_frame",
        });
        return;
      }

      const capturedAtEpochMs = performance.timeOrigin + candidate.capturedAt;
      const blob = await encodeAndCloseImageBitmap(candidate.crop, {
        maxWidth: 640,
        quality: 0.82,
        format: "image/webp",
      });
      if (!blob) {
        socket.emit("score-frame-unavailable", {
          finalisationId: event.finalisationId,
          reason: "encoding_failed",
        });
        return;
      }

      const image = await blob.arrayBuffer();
      if (!active || activeFinalisationRef.current !== event.finalisationId) return;
      socket.emit(
        "score-frame",
        {
          finalisationId: event.finalisationId,
          sampleId: crypto.randomUUID(),
          capturedAtEpochMs,
          mimeType: blob.type,
          image,
        },
        (acknowledgement: EventAcknowledgement) => {
          if (!acknowledgement.ok && active) setRequestError(acknowledgement.error);
        },
      );
    };

    const onStarted = (event: FinalisationStarted) => {
      if (event.battleId !== roomId) return;
      activeFinalisationRef.current = event.finalisationId;
      setRequestError(null);
      setState({ phase: "collecting", finalisationId: event.finalisationId });
      void submitNewestCandidate(event);
    };
    const onAnalysing = (event: FinalisationAnalysing) => {
      if (
        event.battleId !== roomId
        || event.finalisationId !== activeFinalisationRef.current
      ) return;
      setState({ phase: "analysing", finalisationId: event.finalisationId });
    };
    const onResult = (result: ScoreResult) => {
      const activeFinalisation = activeFinalisationRef.current;
      if (!isCurrentScoreResult(result, roomId, activeFinalisation)) return;
      activeFinalisationRef.current = result.finalisationId;
      setRequestError(null);
      setState(
        result.phase === "final"
          ? { phase: "final", result }
          : { phase: "not_scoreable", result },
      );
    };

    socket.on("score-finalisation-started", onStarted);
    socket.on("score-finalisation-analysing", onAnalysing);
    socket.on("score-result", onResult);
    return () => {
      active = false;
      socket.off("score-finalisation-started", onStarted);
      socket.off("score-finalisation-analysing", onAnalysing);
      socket.off("score-result", onResult);
    };
  }, [consumeBestCandidate, roomId, socket]);

  const finalise = useCallback(() => {
    if (!socket || state.phase === "collecting" || state.phase === "analysing" || state.phase === "final") {
      return;
    }
    setRequestError(null);
    socket.emit(
      "score-finalise",
      {},
      (acknowledgement: FinaliseAcknowledgement) => {
        if (!acknowledgement.ok) setRequestError(acknowledgement.error);
      },
    );
  }, [socket, state.phase]);

  return {
    state,
    requestError,
    finalise,
    isBusy: state.phase === "collecting" || state.phase === "analysing",
    isLocked: state.phase === "final",
  };
}
