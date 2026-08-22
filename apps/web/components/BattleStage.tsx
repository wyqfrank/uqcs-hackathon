"use client";

import { Camera, CameraOff, Copy, LogOut, RotateCcw, Snowflake } from "lucide-react";
import type { RefObject } from "react";
import type { CameraStatus } from "@/hooks/useCamera";
import type { ConnectionState } from "@/hooks/useWebRTC";
import type { IceCandidateType, IceRoute } from "@/lib/rtcConfig";
import type { DetectorState, OutfitDetectionResult } from "@/lib/cv/types";
import type { GarmentCategory, GarmentOverlay } from "@/lib/garmentPerception";
import type { BattleScoringState } from "@/lib/scoring";
import type { RoomRole } from "@/lib/signaling";
import { BattleResult } from "./BattleResult";
import { ConnectionStatus } from "./ConnectionStatus";
import { CountdownOverlay } from "./CountdownOverlay";
import { PlayerCard } from "./PlayerCard";
import { ResultOverlay } from "./ResultOverlay";
import { Button } from "./ui/button";

/**
 * Everything the battle screen draws, as a pure function of props.
 *
 * Split out from BattleRoom so the UI can be rendered from mock state without
 * a camera, a peer connection, or a second player — see `app/preview`. States
 * like a draw, a dropped connection mid-round, or a denied camera are
 * otherwise almost impossible to reach deliberately.
 */

export type PlayerPanel = {
  videoRef: RefObject<HTMLVideoElement | null>;
  stream: MediaStream | null;
  /** Remote audio is unmuted in a real battle; preview mutes it so the
      browser will autoplay the placeholder feed without a user gesture. */
  muted?: boolean;
  score: number | null;
  waitingText: string;
  garmentCategories: GarmentCategory[];
  garmentOverlay: GarmentOverlay | null;
  detection?: { state: DetectorState; result: OutfitDetectionResult | null };
};

export type BattleStageProps = {
  roomId: string;
  role: RoomRole;
  copied: boolean;
  connection: {
    state: ConnectionState;
    candidateTypes: IceCandidateType[];
    route: IceRoute | null;
    error: string | null;
  };
  camera: { status: CameraStatus; error: string | null; hasStream: boolean };
  local: PlayerPanel;
  remote: PlayerPanel;
  scoring: {
    state: BattleScoringState;
    isBusy: boolean;
    isLocked: boolean;
    canRematch: boolean;
    scoresAreProvisional: boolean;
    /** Which model produced the live estimates; null when none has reported. */
    liveModelVersion?: string | null;
    error: string | null;
    canFinalise: boolean;
  };
  dismissedResultId: string | null;
  onToggleCamera: () => void;
  onFinalise: () => void;
  onRematch: () => void;
  onCopyRoomCode: () => void;
  onLeave: () => void;
  onDismissResult: (finalisationId: string) => void;
};

function connectionErrorTitle(state: ConnectionState): string {
  if (state === "failed") return "NO VIDEO ROUTE";
  if (state === "error") return "NO BATTLE FOUND";
  return "SIGNAL LOST";
}

function finaliseLabel(phase: BattleScoringState["phase"]): string {
  if (phase === "collecting") return "CAPTURING FITS";
  if (phase === "analysing") return "ANALYSING";
  if (phase === "final") return "SCORE FINAL";
  if (phase === "not_scoreable") return "RETRY SCORE";
  if (phase === "countdown") return "FINALISE EARLY";
  return "WAITING FOR READY";
}

export function BattleStage({
  roomId, role, copied, connection, camera, local, remote, scoring,
  dismissedResultId, onToggleCamera, onFinalise, onRematch, onCopyRoomCode,
  onLeave, onDismissResult,
}: BattleStageProps) {
  return (
    <main className="battle-shell">
      <div className="battle-grid" />
      <nav className="battle-nav">
        <Button variant="bare" size="bare" className="wordmark wordmark-button" onClick={onLeave}>FITTED<span>®</span></Button>
        <ConnectionStatus
          connection={connection.state}
          camera={camera.status}
          candidateTypes={connection.candidateTypes}
          route={connection.route}
        />
        <Button variant="bare" size="bare" className="room-code" onClick={onCopyRoomCode} aria-label={`Copy room code ${roomId}`}>
          <span>ROOM</span><b>{copied ? "COPIED!" : roomId}</b><Copy aria-hidden="true" />
        </Button>
        {/* Only while live estimates are on screen. Naming the model beside a
            number the model did not produce would be worse than saying nothing. */}
        {scoring.scoresAreProvisional && scoring.liveModelVersion && (
          <span className="live-model-tag" title="Model producing the live estimates">
            <i aria-hidden="true" />LIVE<code>{scoring.liveModelVersion}</code>
          </span>
        )}
      </nav>

      {/* Camera and connection can fail independently, so neither hides the other. */}
      {(camera.error || connection.error || scoring.error) && (
        <div className="error-stack">
          {camera.error && (
            <div className="error-banner">
              <b>CAMERA UNAVAILABLE</b>
              <span>{camera.error}</span>
            </div>
          )}
          {connection.error && (
            <div className="error-banner">
              <b>{connectionErrorTitle(connection.state)}</b>
              <span>{connection.error}</span>
              {connection.state !== "error" && (
                <a href="/diagnostics" target="_blank" rel="noreferrer">RUN NETWORK CHECK</a>
              )}
            </div>
          )}
          {scoring.error && (
            <div className="error-banner">
              <b>FINAL RESULT UNAVAILABLE</b>
              <span>{scoring.error}</span>
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
            stream={local.stream} videoRef={local.videoRef} muted
            score={local.score} analysing={scoring.isBusy}
            provisionalScore={scoring.scoresAreProvisional}
            waitingText={local.waitingText}
            detection={local.detection}
            garmentCategories={local.garmentCategories}
            garmentOverlay={local.garmentOverlay}
          />
          <div className="versus-mark"><span>V</span><span>S</span></div>
          <PlayerCard
            label="THEM" number={role === "host" ? "02" : "01"} side="p2"
            stream={remote.stream} videoRef={remote.videoRef} muted={remote.muted ?? false}
            score={remote.score} analysing={scoring.isBusy}
            provisionalScore={scoring.scoresAreProvisional}
            waitingText={remote.waitingText}
            garmentCategories={remote.garmentCategories}
            garmentOverlay={remote.garmentOverlay}
          />
        </div>

        <BattleResult state={scoring.state} role={role} />
      </section>

      {scoring.state.phase === "starting" && (
        <CountdownOverlay secondsRemaining={scoring.state.secondsRemaining} />
      )}

      {scoring.state.phase === "final" && dismissedResultId !== scoring.state.result.finalisationId && (
        <ResultOverlay
          result={scoring.state.result}
          role={role}
          onDismiss={() => onDismissResult(
            scoring.state.phase === "final" ? scoring.state.result.finalisationId : "",
          )}
        />
      )}

      <div className="control-dock">
        <Button variant="bare" size="bare" aria-label={camera.hasStream ? "Stop camera" : "Start camera"} className="primary-control" onClick={onToggleCamera}>
          {camera.hasStream ? <CameraOff aria-hidden="true" /> : <Camera aria-hidden="true" />}
          <span>{camera.hasStream ? "STOP CAMERA" : "START CAMERA"}</span>
        </Button>
        <Button
          variant="bare"
          size="bare"
          aria-label={scoring.isLocked ? "Final score locked" : "Finalise score"}
          className={scoring.isBusy || scoring.isLocked ? "is-active" : ""}
          disabled={!scoring.canFinalise}
          onClick={onFinalise}
        >
          <Snowflake aria-hidden="true" />
          <span>{finaliseLabel(scoring.state.phase)}</span>
        </Button>
        {scoring.canRematch && (
          <Button variant="bare" size="bare" className="rematch-control" aria-label="Start a rematch" onClick={onRematch}>
            <RotateCcw aria-hidden="true" /><span>REMATCH</span>
          </Button>
        )}
        <Button variant="bare" size="bare" aria-label="Copy room code" onClick={onCopyRoomCode}><Copy aria-hidden="true" /><span>{copied ? "COPIED" : "COPY CODE"}</span></Button>
        <Button variant="bare" size="bare" className="leave-control" onClick={onLeave}><LogOut aria-hidden="true" /><span>LEAVE</span></Button>
      </div>
    </main>
  );
}
