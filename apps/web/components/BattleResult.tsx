import { determineWinner } from "@/lib/scoring";
import type { RoomRole } from "@/lib/signaling";

export function BattleResult({ localScore, remoteScore, role }: { localScore: number | null; remoteScore: number | null; role: RoomRole }) {
  if (localScore === null || remoteScore === null) {
    return <div className="battle-result pending"><span>THE VERDICT</span><strong>WAITING FOR BOTH FITS</strong></div>;
  }

  const player1 = role === "host" ? localScore : remoteScore;
  const player2 = role === "host" ? remoteScore : localScore;
  const winner = determineWinner(player1, player2);
  const localWon = (winner === "player1" && role === "host") || (winner === "player2" && role === "guest");
  const verdict = winner === "draw" ? "TOO CLOSE TO CALL" : localWon ? "YOU'RE FITTED" : "THEY'RE FITTED";

  return (
    <div className={`battle-result ${winner === "draw" ? "draw" : localWon ? "winner" : "loser"}`}>
      <span>{localScore.toFixed(1)} <i>VS</i> {remoteScore.toFixed(1)}</span>
      <strong>{verdict}</strong>
    </div>
  );
}
