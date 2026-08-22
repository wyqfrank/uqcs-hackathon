import type { PlayerSide } from "./PlayerCard";

/** Arcade HUD labelling: P1 is 1UP, P2 is 2UP. */
const HUD_LABEL: Record<PlayerSide, string> = {
  p1: "1UP / FIT SCORE",
  p2: "2UP / FIT SCORE",
};

export function FittedScore({ score, active, side }: { score: number | null; active: boolean; side: PlayerSide }) {
  return (
    <div className={`score-block ${active ? "is-active" : ""}`}>
      <span>{HUD_LABEL[side]}</span>
      <strong className="tabular-nums" key={score?.toFixed(1) ?? "empty"}>{score === null ? "--.-" : score.toFixed(1)}</strong>
      <div className="score-track"><i style={{ width: `${score ?? 0}%` }} /></div>
    </div>
  );
}
