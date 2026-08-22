import type { PlayerSide } from "./PlayerCard";

/** Arcade HUD labelling: P1 is 1UP, P2 is 2UP. */
const HUD_PLAYER: Record<PlayerSide, string> = {
  p1: "1UP",
  p2: "2UP",
};

export function FittedScore({
  score,
  active,
  provisional,
  side,
}: {
  score: number | null;
  active: boolean;
  provisional: boolean;
  side: PlayerSide;
}) {
  const visible = score !== null;
  return (
    <div className={`score-block ${active || visible ? "is-active" : ""} ${provisional ? "is-provisional" : ""}`}>
      <span>{HUD_PLAYER[side]} / {provisional ? "LIVE ESTIMATE" : "FIT SCORE"}</span>
      <strong className="tabular-nums" key={score?.toFixed(1) ?? "empty"}>{score === null ? "--.-" : score.toFixed(1)}</strong>
      <div className="score-track"><i style={{ width: `${score ?? 0}%` }} /></div>
    </div>
  );
}
