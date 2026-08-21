export function FittedScore({ score, active }: { score: number | null; active: boolean }) {
  return (
    <div className={`score-block ${active ? "is-active" : ""}`}>
      <span>FIT SCORE</span>
      <strong className="tabular-nums" key={score?.toFixed(1) ?? "empty"}>{score === null ? "—" : score.toFixed(1)}</strong>
      <div className="score-track"><i style={{ width: `${score ?? 0}%` }} /></div>
    </div>
  );
}
