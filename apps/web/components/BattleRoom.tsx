"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useBattleScoring } from "@/hooks/useBattleScoring";
import { useCamera } from "@/hooks/useCamera";
import { useGarmentPerception } from "@/hooks/useGarmentPerception";
import { useOutfitDetection } from "@/hooks/useOutfitDetection";
import { useWebRTC } from "@/hooks/useWebRTC";
import { BattleStage } from "./BattleStage";
import { CV_CONFIG } from "@/lib/cv/config";
import { scoresForRole } from "@/lib/scoring";
import type { RoomRole } from "@/lib/signaling";

export function BattleRoom({
  roomId,
  role,
  playerName = "",
}: {
  roomId: string;
  role: RoomRole;
  playerName?: string;
}) {
  const router = useRouter();
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [copied, setCopied] = useState(false);
  const [dismissedResultId, setDismissedResultId] = useState<string | null>(null);
  const camera = useCamera(true);
  const rtc = useWebRTC(roomId, role, camera.stream, playerName);
  const outfitDetection = useOutfitDetection(localVideoRef, Boolean(camera.stream));
  const localScoreReady =
    rtc.connectionState === "connected"
    && camera.status === "ready"
    && outfitDetection.detectorState === "ready"
    && outfitDetection.result?.scoreable === true
    && performance.now() - outfitDetection.result.capturedAt <= CV_CONFIG.maximumResultAgeMs;
  const scoring = useBattleScoring(
    roomId,
    rtc.socket,
    outfitDetection,
    localScoreReady,
  );
  const garmentPerception = useGarmentPerception(
    roomId,
    role,
    rtc.socket,
    outfitDetection,
    rtc.connectionState === "connected" && !scoring.isBusy && !scoring.isLocked,
  );
  // Garment boxes belong to the live round. Once finalisation starts the server
  // pauses perception, so anything still drawn is a stale reading of a frame
  // that is no longer being judged — and it clutters the result reveal.
  const showGarmentOverlays = !scoring.isBusy && !scoring.canRematch;
  const finalResult = scoring.state.phase === "final" ? scoring.state.result : null;
  const displayedScores = finalResult
    ? scoresForRole(finalResult, role)
    : scoring.provisionalScores
      ? role === "host"
        ? {
            localScore: scoring.provisionalScores.playerA,
            remoteScore: scoring.provisionalScores.playerB,
          }
        : {
            localScore: scoring.provisionalScores.playerB,
            remoteScore: scoring.provisionalScores.playerA,
          }
      : null;
  const scoresAreProvisional = !finalResult && scoring.provisionalScores !== null;
  const localScore = displayedScores?.localScore ?? null;
  const remoteScore = displayedScores?.remoteScore ?? null;
  const scoreError = scoring.requestError
    || (scoring.state.phase === "not_scoreable" ? scoring.state.result.message : null);
  const canFinalise =
    rtc.connectionState === "connected"
    && !scoring.isBusy
    && !scoring.isLocked
    && ["countdown", "not_scoreable"].includes(scoring.state.phase);

  const remoteWaitingText =
    rtc.connectionState === "connected"
      ? "OPPONENT CAMERA OFF"
      : rtc.connectionState === "connecting"
        ? "CONNECTING"
        : rtc.connectionState === "searching"
          ? `LOOKING FOR ${roomId}`
          : rtc.connectionState === "error"
            ? "NO BATTLE FOUND"
            : "WAITING FOR OPPONENT";

  const copyRoomCode = async () => {
    await navigator.clipboard.writeText(roomId);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const leave = () => {
    camera.stopCamera();
    router.push("/");
  };

  return (
    <BattleStage
      roomId={roomId}
      role={role}
      copied={copied}
      connection={{
        state: rtc.connectionState,
        candidateTypes: rtc.candidateTypes,
        route: rtc.route,
        error: rtc.error,
      }}
      camera={{ status: camera.status, error: camera.error, hasStream: Boolean(camera.stream) }}
      local={{
        videoRef: localVideoRef,
        stream: camera.stream,
        score: localScore,
        waitingText: camera.status === "requesting" ? "OPENING CAMERA" : "CAMERA OFF",
        detection: { state: outfitDetection.detectorState, result: outfitDetection.result },
        garmentCategories: garmentPerception.localCategories,
        garmentOverlay: showGarmentOverlays ? garmentPerception.localOverlay : null,
      }}
      remote={{
        videoRef: remoteVideoRef,
        stream: rtc.remoteStream,
        score: remoteScore,
        waitingText: remoteWaitingText,
        garmentCategories: garmentPerception.remoteCategories,
        garmentOverlay: showGarmentOverlays ? garmentPerception.remoteOverlay : null,
      }}
      scoring={{
        state: scoring.state,
        isBusy: scoring.isBusy,
        isLocked: scoring.isLocked,
        canRematch: scoring.canRematch,
        scoresAreProvisional: scoresAreProvisional,
        liveModelVersion: scoring.liveModelVersion,
        error: scoreError,
        canFinalise,
      }}
      dismissedResultId={dismissedResultId}
      onToggleCamera={camera.stream ? camera.stopCamera : () => void camera.startCamera()}
      onFinalise={scoring.finalise}
      onRematch={scoring.rematch}
      onCopyRoomCode={() => void copyRoomCode()}
      onLeave={leave}
      onDismissResult={setDismissedResultId}
    />
  );
}
