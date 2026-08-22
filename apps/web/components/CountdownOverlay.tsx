"use client";

import { BattleOverlay } from "./BattleOverlay";

/**
 * Lead-in before scoring opens.
 *
 * This blocks deliberately: nothing is being judged yet, so covering the feeds
 * costs nothing and gives both players a shared "get set" beat. Once the round
 * itself starts the overlay goes away entirely — the remaining time lives in
 * the strip, and the feeds must stay clear while they are being scored.
 */
export function CountdownOverlay({ secondsRemaining }: { secondsRemaining: number }) {
  return (
    <BattleOverlay label="Round starting">
      <span className="result-eyebrow">GET SET</span>
      {/* `key` retriggers the pop animation on each tick. */}
      <strong className="countdown-number tabular-nums" key={secondsRemaining} aria-live="assertive">
        {secondsRemaining === 0 ? "GO" : secondsRemaining}
      </strong>
      <p className="countdown-hint">Hold your fit in frame</p>
    </BattleOverlay>
  );
}
