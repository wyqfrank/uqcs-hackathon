"use client";

import { BattleOverlay } from "./BattleOverlay";

/**
 * Opening countdown. The scrim stays light because both players are still
 * framing their outfit while this runs — dimming the feeds here would work
 * against the thing the countdown is counting down to.
 */
export function CountdownOverlay({ secondsRemaining }: { secondsRemaining: number }) {
  return (
    <BattleOverlay tone="light" label="Battle starting">
      <span className="countdown-eyebrow">ROUND STARTING</span>
      {/* `key` retriggers the pop animation on each tick. */}
      <strong className="countdown-number tabular-nums" key={secondsRemaining} aria-live="assertive">
        {secondsRemaining}
      </strong>
      <p className="countdown-hint">Hold your fit in frame</p>
    </BattleOverlay>
  );
}
