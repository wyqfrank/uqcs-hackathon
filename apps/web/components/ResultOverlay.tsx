"use client";

import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { localPlayerWon, scoresForRole, type FinalScoreResult } from "@/lib/scoring";
import type { RoomRole } from "@/lib/signaling";
import { BattleOverlay } from "./BattleOverlay";

/**
 * Final verdict, over a dimmed arena. Carries the same numbers as the inline
 * strip; dismissing it falls back to that strip so the result is never lost
 * and the players can look at the frames that produced it.
 */
export function ResultOverlay({
  result,
  role,
  onDismiss,
}: {
  result: FinalScoreResult;
  role: RoomRole;
  onDismiss: () => void;
}) {
  const { localScore, remoteScore } = scoresForRole(result, role);
  const localWon = localPlayerWon(result, role);
  const draw = result.winner === "draw";
  const localBreakdown = role === "host" ? result.breakdown.playerA : result.breakdown.playerB;
  const remoteBreakdown = role === "host" ? result.breakdown.playerB : result.breakdown.playerA;
  const verdict = draw ? "TOO CLOSE TO CALL" : localWon ? "YOU'RE FITTED" : "THEY'RE FITTED";

  const rows = [
    ["COMPONENTS", localBreakdown.componentQuality, remoteBreakdown.componentQuality],
    ["COORDINATION", localBreakdown.outfitCoordination, remoteBreakdown.outfitCoordination],
    ["FIT", localBreakdown.bodyFit, remoteBreakdown.bodyFit],
  ] as const;

  return (
    <BattleOverlay label="Final result">
      <Button
        variant="ghost"
        size="icon"
        className="result-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss result and view the feeds"
        autoFocus
      >
        <X aria-hidden="true" />
      </Button>

      <span className="result-eyebrow">FINAL RESULT</span>

      <div className="result-scores" aria-label={`You ${localScore.toFixed(1)}, them ${remoteScore.toFixed(1)}`}>
        <div className={`result-side ${!draw && localWon ? "is-winner" : ""}`}>
          <span>YOU</span>
          <strong className="tabular-nums">{localScore.toFixed(1)}</strong>
        </div>
        <i aria-hidden="true">VS</i>
        <div className={`result-side ${!draw && !localWon ? "is-winner" : ""}`}>
          <span>THEM</span>
          <strong className="tabular-nums">{remoteScore.toFixed(1)}</strong>
        </div>
      </div>

      <strong className={`result-verdict ${draw ? "is-draw" : localWon ? "is-win" : "is-loss"}`}>
        {verdict}
      </strong>

      <div className="result-rows" aria-label="Scoring breakdown">
        {rows.map(([label, mine, theirs]) => (
          <div key={label} className="result-row">
            {/* Marking the stronger side per row shows *where* the battle was
                won, which the two headline numbers alone do not. */}
            <span className={`tabular-nums ${mine > theirs ? "is-lead" : ""}`}>{mine.toFixed(1)}</span>
            <b>{label}</b>
            <span className={`tabular-nums ${theirs > mine ? "is-lead" : ""}`}>{theirs.toFixed(1)}</span>
          </div>
        ))}
      </div>

      {result.explanation && <p className="result-explanation">{result.explanation}</p>}
    </BattleOverlay>
  );
}
