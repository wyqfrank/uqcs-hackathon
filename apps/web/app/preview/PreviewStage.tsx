"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BattleStage } from "@/components/BattleStage";
import { useCamera } from "@/hooks/useCamera";
import { useLiveFitScore } from "@/hooks/useLiveFitScore";
import { useOutfitDetection } from "@/hooks/useOutfitDetection";
import { SCENARIOS } from "./scenarios";
import { LiveModelReadout } from "./LiveModelReadout";
import { useSimulatedRound } from "./useSimulatedRound";

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

  const sim = useSimulatedRound();
  const scenario = SCENARIOS[index];

  // Live model mode: a real camera and the real ranker, so the scores on
  // screen come from the model rather than from a random walk. The rest of the
  // harness stays mocked — this answers "does the model work on webcam input",
  // which no amount of offline evaluation on curated photos can.
  const [liveModel, setLiveModel] = useState(false);
  const camera = useCamera(false);
  // The same detector the battle uses. It supplies the person crop the model
  // expects and decides whether the player is visible enough to score at all.
  const detection = useOutfitDetection(localVideoRef, liveModel && camera.stream !== null);
  const fit = useLiveFitScore(detection, liveModel);
  useEffect(() => {
    if (liveModel) void camera.startCamera();
    else camera.stopCamera();
  }, [liveModel, camera.startCamera, camera.stopCamera]);
  // While a round is playing it drives the screen; otherwise the picked
  // scenario does. One switch keeps the two from fighting over the state.
  const live = sim.running || sim.state.phase === "final";
  // A new scenario should always show its overlay, even after dismissing one.
  useEffect(() => setDismissed(null), [index]);

  const [localScore, remoteScore] = useMemo<[number | null, number | null]>(
    () => {
      // fit.smoothed is already cleared when the frame stops being scoreable,
      // so a stale number never lingers on the card.
      if (liveModel) return [fit.smoothed, null];
      return live ? (sim.scores ?? [null, null]) : (scenario.scores ?? [null, null]);
    },
    [live, liveModel, fit.smoothed, sim.scores, scenario],
  );

  return (
    <div className="preview-root">
      <nav className="preview-bar">
        <b>PREVIEW</b>
        {/* Only the scenarios scroll. The actions stay pinned: there are more
            scenarios than fit a laptop window, and an action that scrolls off
            the edge may as well not exist. */}
        <div className="preview-scenarios">
          {SCENARIOS.map((s, i) => (
            <button key={s.id} className={i === index && !live ? "is-active" : ""} onClick={() => { sim.stop(); setIndex(i); }}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="preview-actions">
          <button
            className={`preview-live ${liveModel ? "is-active" : ""}`}
            onClick={() => { sim.stop(); setLiveModel((on) => !on); }}
          >
            {liveModel ? "■ STOP MODEL" : "◉ LIVE MODEL"}
          </button>
          <button className={`preview-play ${live ? "is-active" : ""}`} onClick={sim.running ? sim.stop : sim.start}>
            {sim.running ? "■ STOP" : "▶ PLAY ROUND"}
          </button>
        </div>
      </nav>

      <BattleStage
        roomId="FIT-0000"
        role="host"
        copied={false}
        connection={{
          state: live ? "connected" : (scenario.connectionState ?? "connected"),
          candidateTypes: ["host", "srflx"],
          route: null,
          error: scenario.connectionError ?? null,
        }}
        camera={{
          status: liveModel ? camera.status : live ? "ready" : (scenario.cameraStatus ?? "ready"),
          error: liveModel ? camera.error : live ? null : (scenario.cameraError ?? null),
          hasStream: liveModel
            ? camera.stream !== null
            : live ? true : scenario.hasLocalStream !== false,
        }}
        local={{
          videoRef: localVideoRef,
          stream: liveModel
            ? camera.stream
            : !live && scenario.hasLocalStream === false ? null : localStream,
          score: localScore,
          waitingText: scenario.cameraStatus === "denied" ? "CAMERA BLOCKED" : "CAMERA OFF",
          garmentCategories: [],
          garmentOverlay: null,
          // The same overlay the battle shows, so the player is told why they
          // are not being scored in the app's existing vocabulary.
          detection: liveModel
            ? { state: detection.detectorState, result: detection.result }
            : undefined,
        }}
        remote={{
          videoRef: remoteVideoRef,
          muted: true,
          stream: !live && scenario.hasRemoteStream === false ? null : remoteStream,
          score: remoteScore,
          waitingText: scenario.connectionState === "searching" ? "LOOKING FOR FIT-0000" : "WAITING FOR OPPONENT",
          garmentCategories: [],
          garmentOverlay: null,
        }}
        scoring={{
          state: live ? sim.state : scenario.state,
          isBusy: ["collecting", "analysing"].includes((live ? sim.state : scenario.state).phase),
          isLocked: (live ? sim.state : scenario.state).phase === "final",
          canRematch: (live ? sim.state : scenario.state).phase === "final",
          scoresAreProvisional: liveModel
            ? true
            : live ? sim.provisional : (scenario.provisional ?? false),
          liveModelVersion: liveModel ? fit.modelVersion : null,
          error: null,
          canFinalise: (live ? sim.state : scenario.state).phase === "countdown",
        }}
        dismissedResultId={dismissed}
        onToggleCamera={() => {}}
        onFinalise={() => {}}
        onRematch={() => {}}
        onCopyRoomCode={() => {}}
        onLeave={() => {}}
        onDismissResult={setDismissed}
      />
      {liveModel ? (
        <LiveModelReadout
          fit={fit}
          cameraStatus={camera.status}
          detectorState={detection.detectorState}
        />
      ) : null}
    </div>
  );
}
