import { useEffect, type RefObject } from "react";
import { Camera } from "lucide-react";
import type { DetectorState, OutfitDetectionResult } from "@/lib/cv/types";
import type { GarmentCategory } from "@/lib/garmentPerception";
import { FittedScore } from "./FittedScore";
import { GarmentCategoryChips } from "./GarmentCategoryChips";
import { OutfitDetectionOverlay } from "./OutfitDetectionOverlay";

/** Cabinet side: P1 runs magenta and mirrors right, P2 runs acid green and mirrors left. */
export type PlayerSide = "p1" | "p2";

export function PlayerCard({
  label,
  number,
  side,
  stream,
  videoRef,
  muted,
  score,
  analysing,
  waitingText,
  detection,
  garmentCategories = [],
}: {
  label: string;
  number: string;
  side: PlayerSide;
  stream: MediaStream | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  muted: boolean;
  score: number | null;
  analysing: boolean;
  waitingText: string;
  garmentCategories?: GarmentCategory[];
  detection?: {
    state: DetectorState;
    result: OutfitDetectionResult | null;
  };
}) {
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream, videoRef]);

  return (
    <article className={`player-card is-${side} ${stream ? "has-stream" : ""}`}>
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
        <FittedScore score={score} active={analysing} side={side} />
        <GarmentCategoryChips categories={garmentCategories} />
      </div>
    </article>
  );
}
