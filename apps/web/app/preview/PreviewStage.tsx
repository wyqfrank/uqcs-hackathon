"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BattleStage } from "@/components/BattleStage";
import { SCENARIOS } from "./scenarios";

/**
 * Renders the real BattleStage from mock state. Nothing here touches a camera,
 * a peer connection or the signalling server.
 */

/**
 * A canvas-backed MediaStream stands in for a webcam, so the video panels show
 * a genuine <video> element at the real aspect rather than an empty box.
 */
function usePlaceholderStream(label: string, hue: number): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 720;
    canvas.height = 1080;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let frame = 0;
    const draw = () => {
      frame += 1;
      ctx.fillStyle = `hsl(${hue} 18% 12%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = `hsl(${hue} 45% 26%)`;
      ctx.fillRect(180, 250, 360, 430);
      ctx.fillRect(230, 680, 260, 330);
      ctx.beginPath();
      ctx.arc(360, 170, 95, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.5)";
      ctx.font = "600 34px monospace";
      ctx.textAlign = "center";
      ctx.fillText(label, 360, 1050);
      // A moving element proves the element is live rather than a still.
      ctx.fillStyle = "hsl(28 100% 50%)";
      ctx.fillRect(40, 40 + ((frame * 4) % 900), 10, 60);
    };
    draw();
    const timer = window.setInterval(draw, 90);
    setStream(canvas.captureStream(12));
    return () => window.clearInterval(timer);
  }, [label, hue]);
  return stream;
}

export function PreviewStage() {
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const localStream = usePlaceholderStream("YOU", 300);
  const remoteStream = usePlaceholderStream("THEM", 90);

  const scenario = SCENARIOS[index];
  // A new scenario should always show its overlay, even after dismissing one.
  useEffect(() => setDismissed(null), [index]);

  const [localScore, remoteScore] = useMemo(
    () => scenario.scores ?? [null, null],
    [scenario],
  );

  return (
    <div className="preview-root">
      <nav className="preview-bar">
        <b>PREVIEW</b>
        {SCENARIOS.map((s, i) => (
          <button key={s.id} className={i === index ? "is-active" : ""} onClick={() => setIndex(i)}>
            {s.label}
          </button>
        ))}
      </nav>

      <BattleStage
        roomId="FIT-0000"
        role="host"
        copied={false}
        connection={{
          state: scenario.connectionState ?? "connected",
          candidateTypes: ["host", "srflx"],
          route: null,
          error: scenario.connectionError ?? null,
        }}
        camera={{
          status: scenario.cameraStatus ?? "ready",
          error: scenario.cameraError ?? null,
          hasStream: scenario.hasLocalStream !== false,
        }}
        local={{
          videoRef: localVideoRef,
          stream: scenario.hasLocalStream === false ? null : localStream,
          score: localScore,
          waitingText: scenario.cameraStatus === "denied" ? "CAMERA BLOCKED" : "CAMERA OFF",
          garmentCategories: [],
          garmentOverlay: null,
        }}
        remote={{
          videoRef: remoteVideoRef,
          muted: true,
          stream: scenario.hasRemoteStream === false ? null : remoteStream,
          score: remoteScore,
          waitingText: scenario.connectionState === "searching" ? "LOOKING FOR FIT-0000" : "WAITING FOR OPPONENT",
          garmentCategories: [],
          garmentOverlay: null,
        }}
        scoring={{
          state: scenario.state,
          isBusy: scenario.state.phase === "collecting" || scenario.state.phase === "analysing",
          isLocked: scenario.state.phase === "final",
          canRematch: scenario.state.phase === "final",
          scoresAreProvisional: scenario.provisional ?? false,
          error: null,
          canFinalise: scenario.state.phase === "countdown",
        }}
        dismissedResultId={dismissed}
        onToggleCamera={() => {}}
        onFinalise={() => {}}
        onRematch={() => {}}
        onCopyRoomCode={() => {}}
        onLeave={() => {}}
        onDismissResult={setDismissed}
      />
    </div>
  );
}
