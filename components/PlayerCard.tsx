import { useEffect, type RefObject } from "react";
import { Camera } from "lucide-react";
import type { DetectorState, OutfitDetectionResult } from "@/lib/cv/types";
import { FittedScore } from "./FittedScore";
import { OutfitDetectionOverlay } from "./OutfitDetectionOverlay";

export function PlayerCard({
  label,
  number,
  stream,
  videoRef,
  muted,
  score,
  analysing,
  waitingText,
  detection,
}: {
  label: string;
  number: string;
  stream: MediaStream | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  muted: boolean;
  score: number | null;
  analysing: boolean;
  waitingText: string;
  detection?: {
    state: DetectorState;
    result: OutfitDetectionResult | null;
  };
}) {
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, videoRef]);

  return (
    <article className={`player-card ${stream ? "has-stream" : ""}`}>
      <header>
        <div><span className="player-number">{number}</span><b>{label}</b></div>
        <span className={`analysis-label ${analysing ? "is-on" : ""}`}><i /> {analysing ? "ANALYSING FIT" : "AWAITING FEED"}</span>
      </header>
      <div className="video-stage">
        <video ref={videoRef} autoPlay playsInline muted={muted} />
        {stream && detection && (
          <OutfitDetectionOverlay
            videoRef={videoRef}
            detectorState={detection.state}
            result={detection.result}
          />
        )}
        {!stream && (
          <div className="video-placeholder">
            <span><Camera aria-hidden="true" /></span>
            <b>{waitingText}</b>
            <small>Camera feed will appear here</small>
          </div>
        )}
        <div className="corner corner-tl" /><div className="corner corner-tr" />
        <div className="corner corner-bl" /><div className="corner corner-br" />
        <FittedScore score={score} active={analysing} />
      </div>
    </article>
  );
}
