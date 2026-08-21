import { useEffect, type RefObject } from "react";
import { Camera } from "lucide-react";
import { MogScore } from "./MogScore";

export function PlayerCard({
  label,
  number,
  stream,
  videoRef,
  muted,
  score,
  analysing,
  waitingText,
}: {
  label: string;
  number: string;
  stream: MediaStream | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  muted: boolean;
  score: number | null;
  analysing: boolean;
  waitingText: string;
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
        {!stream && (
          <div className="video-placeholder">
            <span><Camera aria-hidden="true" /></span>
            <b>{waitingText}</b>
            <small>Camera feed will appear here</small>
          </div>
        )}
        <div className="corner corner-tl" /><div className="corner corner-tr" />
        <div className="corner corner-bl" /><div className="corner corner-br" />
        <MogScore score={score} active={analysing} />
      </div>
    </article>
  );
}
