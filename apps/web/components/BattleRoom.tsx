"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, CameraOff, Copy, LogOut, Snowflake } from "lucide-react";
import { useBattleScoring } from "@/hooks/useBattleScoring";
import { useCamera } from "@/hooks/useCamera";
import { useGarmentPerception } from "@/hooks/useGarmentPerception";
import { useOutfitDetection } from "@/hooks/useOutfitDetection";
import { useWebRTC, type ConnectionState } from "@/hooks/useWebRTC";
import { CV_CONFIG } from "@/lib/cv/config";
import { scoresForRole } from "@/lib/scoring";
import type { RoomRole } from "@/lib/signaling";
import { BattleResult } from "./BattleResult";
import { ConnectionStatus } from "./ConnectionStatus";
import { PlayerCard } from "./PlayerCard";
import { Button } from "./ui/button";

function connectionErrorTitle(state: ConnectionState): string {
  if (state === "failed") return "NO VIDEO ROUTE";
  if (state === "error") return "NO BATTLE FOUND";
  return "SIGNAL LOST";
}

export function BattleRoom({ roomId, role }: { roomId: string; role: RoomRole }) {
  const router = useRouter();
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [copied, setCopied] = useState(false);
  const camera = useCamera(true);
  const rtc = useWebRTC(roomId, role, camera.stream);
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
  const finalResult = scoring.state.phase === "final" ? scoring.state.result : null;
  const displayedScores = finalResult ? scoresForRole(finalResult, role) : null;
  const localScore = displayedScores?.localScore ?? null;
  const remoteScore = displayedScores?.remoteScore ?? null;
  const scoreError = scoring.requestError
    || (scoring.state.phase === "not_scoreable" ? scoring.state.result.message : null);
  const canFinalise =
    rtc.connectionState === "connected"
    && !scoring.isBusy
    && !scoring.isLocked
    && ["countdown", "not_scoreable"].includes(scoring.state.phase);

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
    <main className="battle-shell">
      <div className="battle-grid" />
      <nav className="battle-nav">
        <Button variant="bare" size="bare" className="wordmark wordmark-button" onClick={leave}>FITTED<span>®</span></Button>
        <ConnectionStatus
          connection={rtc.connectionState}
          camera={camera.status}
          candidateTypes={rtc.candidateTypes}
          route={rtc.route}
        />
        <Button variant="bare" size="bare" className="room-code" onClick={copyRoomCode} aria-label={`Copy room code ${roomId}`}>
          <span>ROOM</span><b>{copied ? "COPIED!" : roomId}</b><Copy aria-hidden="true" />
        </Button>
      </nav>

      {/* Camera and connection can fail independently, so neither hides the other. */}
      {(camera.error || rtc.error || scoreError) && (
        <div className="error-stack">
          {camera.error && (
            <div className="error-banner">
              <b>CAMERA UNAVAILABLE</b>
              <span>{camera.error}</span>
            </div>
          )}
          {rtc.error && (
            <div className="error-banner">
              <b>{connectionErrorTitle(rtc.connectionState)}</b>
              <span>{rtc.error}</span>
              {rtc.connectionState !== "error" && (
                <a href="/diagnostics" target="_blank" rel="noreferrer">RUN NETWORK CHECK</a>
              )}
            </div>
          )}
          {scoreError && (
            <div className="error-banner">
              <b>FINAL RESULT UNAVAILABLE</b>
              <span>{scoreError}</span>
            </div>
          )}
        </div>
      )}

      <section className="arena">
        <div className="arena-heading">
          <span>LIVE / HEAD TO HEAD</span>
          <h1>YOU <i>VS</i> THEM</h1>
          <span>{role === "host" ? "PLAYER 01 / HOST" : "PLAYER 02 / CHALLENGER"}</span>
        </div>

        <div className="players">
          <PlayerCard
            label="YOU" number={role === "host" ? "01" : "02"} side="p1"
            stream={camera.stream} videoRef={localVideoRef} muted
            score={localScore} analysing={scoring.isBusy}
            waitingText={camera.status === "requesting" ? "OPENING CAMERA" : "CAMERA OFF"}
            detection={{ state: outfitDetection.detectorState, result: outfitDetection.result }}
            garmentCategories={garmentPerception.localCategories}
          />
          <div className="versus-mark"><span>V</span><span>S</span></div>
          <PlayerCard
            label="THEM" number={role === "host" ? "02" : "01"} side="p2"
            stream={rtc.remoteStream} videoRef={remoteVideoRef} muted={false}
            score={remoteScore} analysing={scoring.isBusy}
            waitingText={
              rtc.connectionState === "connected"
                ? "OPPONENT CAMERA OFF"
                : rtc.connectionState === "connecting"
                  ? "CONNECTING"
                  : rtc.connectionState === "searching"
                    ? `LOOKING FOR ${roomId}`
                    : rtc.connectionState === "error"
                      ? "NO BATTLE FOUND"
                      : "WAITING FOR OPPONENT"
            }
            garmentCategories={garmentPerception.remoteCategories}
          />
        </div>

        <BattleResult state={scoring.state} role={role} />
      </section>

      <div className="control-dock">
        <Button variant="bare" size="bare" aria-label={camera.stream ? "Stop camera" : "Start camera"} className="primary-control" onClick={camera.stream ? camera.stopCamera : () => void camera.startCamera()}>
          {camera.stream ? <CameraOff aria-hidden="true" /> : <Camera aria-hidden="true" />}<span>{camera.stream ? "STOP CAMERA" : "START CAMERA"}</span>
        </Button>
        <Button
          variant="bare"
          size="bare"
          aria-label={scoring.isLocked ? "Final score locked" : "Finalise score"}
          className={scoring.isBusy || scoring.isLocked ? "is-active" : ""}
          disabled={!canFinalise}
          onClick={scoring.finalise}
        >
          <Snowflake aria-hidden="true" />
          <span>
            {scoring.state.phase === "collecting"
              ? "CAPTURING FITS"
              : scoring.state.phase === "analysing"
                ? "ANALYSING"
                : scoring.state.phase === "final"
                  ? "SCORE FINAL"
                  : scoring.state.phase === "not_scoreable"
                    ? "RETRY SCORE"
                    : scoring.state.phase === "countdown"
                      ? "FINALISE EARLY"
                      : "WAITING FOR READY"}
          </span>
        </Button>
        <Button variant="bare" size="bare" aria-label="Copy room code" onClick={() => void copyRoomCode()}><Copy aria-hidden="true" /><span>{copied ? "COPIED" : "COPY CODE"}</span></Button>
        <Button variant="bare" size="bare" className="leave-control" onClick={leave}><LogOut aria-hidden="true" /><span>LEAVE</span></Button>
      </div>
    </main>
  );
}
