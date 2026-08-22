"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { encodeAndCloseImageBitmap } from "@/lib/captureFrame";
import type { OutfitDetectionController } from "@/lib/cv/types";
import {
  countdownSeconds,
  isCurrentScoreResult,
  type BattleScoringState,
  type ScoreResult,
} from "@/lib/scoring";

type ReadinessUpdated = {
  battleId: string;
  playerAReady: boolean;
  playerBReady: boolean;
};

type RoundStarted = {
  battleId: string;
  roundId: string;
  serverNow: number;
  endsAt: number;
};

type RoundCancelled = {
  battleId: string;
  roundId: string | null;
  reason: string;
};

type FinalisationStarted = {
  battleId: string;
  finalisationId: string;
  deadlineAt: number;
  burstCount: number;
};

type FrameRequest = {
  battleId: string;
  finalisationId: string;
  requestId: string;
  burstIndex: number;
  serverNow: number;
  deadlineAt: number;
};

type FinalisationAnalysing = {
  battleId: string;
  finalisationId: string;
  pairId: string;
  sampleCount: number;
};

type EventAcknowledgement = { ok: true } | { ok: false; error: string };
type FinaliseAcknowledgement =
  | { ok: true; finalisationId: string; locked: boolean }
  | { ok: false; error: string };

const CANDIDATE_POLL_MS = 80;
const COUNTDOWN_TICK_MS = 100;

const wait = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

export function useBattleScoring(
  roomId: string,
  socket: Socket | null,
  detection: OutfitDetectionController,
  localScoreReady: boolean,
) {
  const [state, setState] = useState<BattleScoringState>({
    phase: "waiting_ready",
    playerAReady: false,
    playerBReady: false,
  });
  const [requestError, setRequestError] = useState<string | null>(null);
  const activeFinalisationRef = useRef<string | null>(null);
  const submittedRequestsRef = useRef(new Set<string>());
  const readinessRef = useRef({ playerAReady: false, playerBReady: false });
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consumeBestCandidate = detection.consumeBestCandidate;
  const detectorStateRef = useRef(detection.detectorState);
  detectorStateRef.current = detection.detectorState;

  useEffect(() => {
    if (!socket) return;
    socket.emit("score-readiness", { ready: localScoreReady });
  }, [localScoreReady, socket]);

  useEffect(() => {
    if (!socket) return;
    return () => {
      if (socket.connected) socket.emit("score-readiness", { ready: false });
    };
  }, [socket]);

  useEffect(() => {
    if (!socket) return;
    let active = true;

    const stopCountdown = () => {
      if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    };

    const submitNewestCandidate = async (event: FrameRequest) => {
      if (submittedRequestsRef.current.has(event.requestId)) return;
      submittedRequestsRef.current.add(event.requestId);
      const localDeadline = performance.now() + Math.max(0, event.deadlineAt - event.serverNow);

      let candidate = consumeBestCandidate();
      while (!candidate && active && performance.now() < localDeadline) {
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
          requestId: event.requestId,
          burstIndex: event.burstIndex,
          reason: detectorStateRef.current === "unavailable"
            ? "detector_unavailable"
            : "no_stable_frame",
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
          requestId: event.requestId,
          burstIndex: event.burstIndex,
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
          requestId: event.requestId,
          burstIndex: event.burstIndex,
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

    const onReadiness = (event: ReadinessUpdated) => {
      if (event.battleId !== roomId) return;
      readinessRef.current = {
        playerAReady: event.playerAReady,
        playerBReady: event.playerBReady,
      };
      setState((current) => current.phase === "waiting_ready"
        ? { phase: "waiting_ready", ...readinessRef.current }
        : current);
    };
    const onRoundStarted = (event: RoundStarted) => {
      if (event.battleId !== roomId) return;
      stopCountdown();
      activeFinalisationRef.current = null;
      submittedRequestsRef.current.clear();
      setRequestError(null);
      const localDeadline = performance.now() + Math.max(0, event.endsAt - event.serverNow);
      const updateCountdown = () => {
        if (!active) return;
        setState({
          phase: "countdown",
          roundId: event.roundId,
          secondsRemaining: countdownSeconds(localDeadline, performance.now()),
        });
      };
      updateCountdown();
      countdownTimerRef.current = setInterval(updateCountdown, COUNTDOWN_TICK_MS);
    };
    const onRoundCancelled = (event: RoundCancelled) => {
      if (event.battleId !== roomId) return;
      stopCountdown();
      activeFinalisationRef.current = null;
      submittedRequestsRef.current.clear();
      setState({ phase: "waiting_ready", ...readinessRef.current });
    };
    const onStarted = (event: FinalisationStarted) => {
      if (event.battleId !== roomId) return;
      stopCountdown();
      activeFinalisationRef.current = event.finalisationId;
      submittedRequestsRef.current.clear();
      setRequestError(null);
      setState({ phase: "collecting", finalisationId: event.finalisationId });
    };
    const onFrameRequest = (event: FrameRequest) => {
      if (
        event.battleId !== roomId
        || event.finalisationId !== activeFinalisationRef.current
      ) return;
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
      stopCountdown();
      activeFinalisationRef.current = result.finalisationId;
      setRequestError(null);
      setState(
        result.phase === "final"
          ? { phase: "final", result }
          : { phase: "not_scoreable", result },
      );
    };

    socket.on("score-readiness-updated", onReadiness);
    socket.on("score-round-started", onRoundStarted);
    socket.on("score-round-cancelled", onRoundCancelled);
    socket.on("score-finalisation-started", onStarted);
    socket.on("score-frame-request", onFrameRequest);
    socket.on("score-finalisation-analysing", onAnalysing);
    socket.on("score-result", onResult);
    return () => {
      active = false;
      stopCountdown();
      socket.off("score-readiness-updated", onReadiness);
      socket.off("score-round-started", onRoundStarted);
      socket.off("score-round-cancelled", onRoundCancelled);
      socket.off("score-finalisation-started", onStarted);
      socket.off("score-frame-request", onFrameRequest);
      socket.off("score-finalisation-analysing", onAnalysing);
      socket.off("score-result", onResult);
    };
  }, [consumeBestCandidate, roomId, socket]);

  const finalise = useCallback(() => {
    if (
      !socket
      || !["countdown", "not_scoreable"].includes(state.phase)
    ) return;
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
