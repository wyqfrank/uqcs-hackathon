"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, CameraOff, Copy, LogOut, Snowflake } from "lucide-react";
import { useCamera } from "@/hooks/useCamera";
import { useInference } from "@/hooks/useInference";
import { useWebRTC } from "@/hooks/useWebRTC";
import type { RoomRole } from "@/lib/signaling";
import { BattleResult } from "./BattleResult";
import { ConnectionStatus } from "./ConnectionStatus";
import { PlayerCard } from "./PlayerCard";
import { Button } from "./ui/button";

export function BattleRoom({ roomId, role }: { roomId: string; role: RoomRole }) {
  const router = useRouter();
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [frozen, setFrozen] = useState(false);
  const [copied, setCopied] = useState(false);
  const camera = useCamera(true);
  const rtc = useWebRTC(roomId, role, camera.stream);
  const localInference = useInference(localVideoRef, Boolean(camera.stream), frozen);
  const remoteInference = useInference(remoteVideoRef, Boolean(rtc.remoteStream), frozen);

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
        <Button variant="bare" size="bare" className="wordmark wordmark-button" onClick={leave}>MOG<span>®</span></Button>
        <ConnectionStatus connection={rtc.connectionState} camera={camera.status} />
        <Button variant="bare" size="bare" className="room-code" onClick={copyRoomCode} aria-label={`Copy room code ${roomId}`}>
          <span>ROOM</span><b>{copied ? "COPIED!" : roomId}</b><Copy aria-hidden="true" />
        </Button>
      </nav>

      {(camera.error || rtc.error) && (
        <div className="error-banner"><b>{camera.error ? "CAMERA UNAVAILABLE" : "SIGNAL LOST"}</b><span>{camera.error || rtc.error}</span></div>
      )}

      <section className="arena">
        <div className="arena-heading">
          <span>LIVE / HEAD TO HEAD</span>
          <h1>YOU <i>VS</i> THEM</h1>
          <span>{role === "host" ? "PLAYER 01 / HOST" : "PLAYER 02 / CHALLENGER"}</span>
        </div>

        <div className="players">
          <PlayerCard
            label="YOU" number={role === "host" ? "01" : "02"}
            stream={camera.stream} videoRef={localVideoRef} muted
            score={localInference.score} analysing={localInference.isAnalysing}
            waitingText={camera.status === "requesting" ? "OPENING CAMERA" : "CAMERA OFF"}
          />
          <div className="versus-mark"><span>V</span><span>S</span></div>
          <PlayerCard
            label="THEM" number={role === "host" ? "02" : "01"}
            stream={rtc.remoteStream} videoRef={remoteVideoRef} muted={false}
            score={remoteInference.score} analysing={remoteInference.isAnalysing}
            waitingText={rtc.connectionState === "connecting" ? "CONNECTING" : "WAITING FOR OPPONENT"}
          />
        </div>

        <BattleResult localScore={localInference.score} remoteScore={remoteInference.score} role={role} />
      </section>

      <div className="control-dock">
        <Button variant="bare" size="bare" aria-label={camera.stream ? "Stop camera" : "Start camera"} onClick={camera.stream ? camera.stopCamera : () => void camera.startCamera()}>
          {camera.stream ? <CameraOff aria-hidden="true" /> : <Camera aria-hidden="true" />}<span>{camera.stream ? "STOP CAMERA" : "START CAMERA"}</span>
        </Button>
        <Button variant="bare" size="bare" aria-label={frozen ? "Resume score" : "Freeze score"} className={frozen ? "is-active" : ""} onClick={() => setFrozen((value) => !value)}>
          <Snowflake aria-hidden="true" /><span>{frozen ? "RESUME SCORE" : "FREEZE SCORE"}</span>
        </Button>
        <Button variant="bare" size="bare" aria-label="Copy room code" onClick={() => void copyRoomCode()}><Copy aria-hidden="true" /><span>{copied ? "COPIED" : "COPY CODE"}</span></Button>
        <Button variant="bare" size="bare" className="leave-control" onClick={leave}><LogOut aria-hidden="true" /><span>LEAVE</span></Button>
      </div>
    </main>
  );
}
