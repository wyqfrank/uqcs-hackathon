"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { encodeAndCloseImageBitmap } from "@/lib/captureFrame";
import type { OutfitDetectionController } from "@/lib/cv/types";
import {
  countdownSeconds,
  isCurrentScoreResult,
  provisionalScoresForRound,
  type BattleScoringState,
  type ProvisionalScorePair,
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
/**
 * Stop hunting for a well-framed candidate this far before the server's
 * deadline. Polling right up to it meant the reply always landed after the slot
 * had closed, so the server recorded "pending" — no frame and no reason — and
 * the battle failed with a message about cameras rather than framing.
 */
const RESPONSE_MARGIN_MS = 220;

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
  const [provisionalScores, setProvisionalScores] = useState<ProvisionalScorePair | null>(null);
  const activeFinalisationRef = useRef<string | null>(null);
  const submittedRequestsRef = useRef(new Set<string>());
  const readinessRef = useRef({ playerAReady: false, playerBReady: false });
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const captureCurrentCandidate = detection.captureCurrentCandidate;
  const consumeBestCandidate = detection.consumeBestCandidate;
  const captureFallbackCandidate = detection.captureFallbackCandidate;
  const frameStatusRef = useRef(detection.result?.stableStatus ?? null);
  frameStatusRef.current = detection.result?.stableStatus ?? null;
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

    const submitCurrentFrame = async (event: FrameRequest) => {
      if (submittedRequestsRef.current.has(event.requestId)) return;
      submittedRequestsRef.current.add(event.requestId);
      const localDeadline = performance.now() + Math.max(0, event.deadlineAt - event.serverNow);
      const searchUntil = localDeadline - RESPONSE_MARGIN_MS;

      let candidate = await captureCurrentCandidate();
      if (!candidate) candidate = consumeBestCandidate();
      while (!candidate && active && performance.now() < searchUntil) {
        await wait(CANDIDATE_POLL_MS);
        candidate = await captureCurrentCandidate();
        if (!candidate) candidate = consumeBestCandidate();
      }

      // Nothing passed frame-quality gating. Send the current view anyway: the
      // scoring provider reports frame quality itself and returns null scores
      // for an unusable player, which is a judged outcome. Submitting nothing
      // just fails the whole battle for both players.
      let degradedReason: string | null = null;
      if (!candidate) {
        candidate = await captureFallbackCandidate();
        degradedReason = frameStatusRef.current ?? "no_stable_frame";
      }
      if (!active || activeFinalisationRef.current !== event.finalisationId) {
        candidate?.crop.close();
        if (active) {
          socket.emit("score-frame-unavailable", {
            finalisationId: event.finalisationId,
            requestId: event.requestId,
            burstIndex: event.burstIndex,
            reason: "stale_finalisation",
          });
        }
        return;
      }
      if (!candidate) {
        socket.emit("score-frame-unavailable", {
          finalisationId: event.finalisationId,
          requestId: event.requestId,
          burstIndex: event.burstIndex,
          reason: detectorStateRef.current === "unavailable"
            ? "detector_unavailable"
            : frameStatusRef.current ?? "no_current_frame",
        });
        return;
      }

      const capturedAtEpochMs = performance.timeOrigin + candidate.capturedAt;
      const blob = await encodeAndCloseImageBitmap(candidate.crop, {
        // Upload time scales with frame size where model latency does not, and
        // browsers without WebP fall back to a much heavier JPEG. 512px at 0.72
        // is ample for judging an outfit crop.
        maxWidth: 512,
        quality: 0.72,
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
      if (!active || activeFinalisationRef.current !== event.finalisationId) {
        if (active) {
          socket.emit("score-frame-unavailable", {
            finalisationId: event.finalisationId,
            requestId: event.requestId,
            burstIndex: event.burstIndex,
            reason: "stale_finalisation",
          });
        }
        return;
      }
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
          // Non-null when frame-quality gating never passed, so the failure is
          // attributable if the provider then calls the frame unusable.
          degraded: degradedReason,
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
        const now = performance.now();
        const remainingSeconds = Math.max(0, localDeadline - now) / 1000;
        const secondsRemaining = countdownSeconds(localDeadline, now);
        setState({
          phase: "countdown",
          roundId: event.roundId,
          secondsRemaining,
        });
        setProvisionalScores(provisionalScoresForRound(event.roundId, remainingSeconds));
      };
      updateCountdown();
      countdownTimerRef.current = setInterval(updateCountdown, COUNTDOWN_TICK_MS);
    };
    const onRoundCancelled = (event: RoundCancelled) => {
      if (event.battleId !== roomId) return;
      stopCountdown();
      activeFinalisationRef.current = null;
      submittedRequestsRef.current.clear();
      setProvisionalScores(null);
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
      if (event.battleId !== roomId) return;
      // A request for a finalisation this client does not know about used to be
      // dropped in silence, which the server could only record as "pending" —
      // no frame and no reason. Say so instead.
      if (event.finalisationId !== activeFinalisationRef.current) {
        socket.emit("score-frame-unavailable", {
          finalisationId: event.finalisationId,
          requestId: event.requestId,
          burstIndex: event.burstIndex,
          reason: "stale_finalisation",
        });
        return;
      }
      void submitCurrentFrame(event).catch(() => {
        // An exception mid-capture must not look like an unresponsive client.
        socket.emit("score-frame-unavailable", {
          finalisationId: event.finalisationId,
          requestId: event.requestId,
          burstIndex: event.burstIndex,
          reason: "capture_failed",
        });
      });
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
      if (result.phase === "final") setProvisionalScores(null);
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
  }, [captureCurrentCandidate, captureFallbackCandidate, consumeBestCandidate, roomId, socket]);

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
    provisionalScores,
    requestError,
    finalise,
    isBusy: state.phase === "collecting" || state.phase === "analysing",
    isLocked: state.phase === "final",
  };
}
