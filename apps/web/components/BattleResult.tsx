import { localPlayerWon, scoresForRole, type BattleScoringState } from "@/lib/scoring";
import type { RoomRole } from "@/lib/signaling";

export function BattleResult({
  state,
  role,
}: {
  state: BattleScoringState;
  role: RoomRole;
}) {
  if (state.phase === "waiting_ready") {
    const localReady = role === "host" ? state.playerAReady : state.playerBReady;
    const remoteReady = role === "host" ? state.playerBReady : state.playerAReady;
    return (
      <div className="battle-result pending">
        <span>GET READY</span>
        <strong>FRAME BOTH FITS TO START</strong>
        <div className="round-readiness" aria-label="Battle readiness">
          <span className={localReady ? "is-ready" : ""}>YOU {localReady ? "READY" : "FRAMING"}</span>
          <span className={remoteReady ? "is-ready" : ""}>THEM {remoteReady ? "READY" : "FRAMING"}</span>
        </div>
      </div>
    );
  }
  if (state.phase === "countdown") {
    const seconds = String(state.secondsRemaining).padStart(2, "0");
    return (
      <div className="battle-result pending countdown-result" aria-live="polite">
        <span>ROUND LIVE</span>
        <strong className="battle-countdown">00:{seconds}</strong>
        <p>Keep both fits framed. Final analysis begins automatically.</p>
      </div>
    );
  }
  if (state.phase === "collecting" || state.phase === "analysing") {
    return (
      <div className="battle-result pending">
        <span>FINALISING</span>
        <strong>{state.phase === "collecting" ? "CAPTURING BOTH FITS" : "ANALYSING FINAL RESULT"}</strong>
      </div>
    );
  }
  if (state.phase === "not_scoreable") {
    return (
      <div className="battle-result pending">
        <span>FINAL RESULT UNAVAILABLE</span>
        <strong>{state.result.message}</strong>
      </div>
    );
  }

  const { result } = state;
  const { localScore, remoteScore } = scoresForRole(result, role);
  const localWon = localPlayerWon(result, role);
  const localBreakdown = role === "host" ? result.breakdown.playerA : result.breakdown.playerB;
  const remoteBreakdown = role === "host" ? result.breakdown.playerB : result.breakdown.playerA;
  const verdict = result.winner === "draw"
    ? "TOO CLOSE TO CALL"
    : localWon ? "YOU'RE FITTED" : "THEY'RE FITTED";

  return (
    <div className={`battle-result ${result.winner === "draw" ? "draw" : localWon ? "winner" : "loser"}`}>
      <span>{localScore.toFixed(1)} <i>VS</i> {remoteScore.toFixed(1)}</span>
      <strong>{verdict}</strong>
      <div className="result-breakdown" aria-label="Final scoring breakdown">
        <span>COMPONENTS {localBreakdown.componentQuality.toFixed(1)} / {remoteBreakdown.componentQuality.toFixed(1)}</span>
        <span>COORDINATION {localBreakdown.outfitCoordination.toFixed(1)} / {remoteBreakdown.outfitCoordination.toFixed(1)}</span>
        <span>FIT {localBreakdown.bodyFit.toFixed(1)} / {remoteBreakdown.bodyFit.toFixed(1)}</span>
      </div>
      <p>{result.explanation}</p>
    </div>
  );
}
