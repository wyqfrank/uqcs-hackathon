"use client";

/**
 * Round timer.
 *
 * The `countdown` phase IS the scored round, not a lead-in to it: provisional
 * scores update on the feeds every tick and garment perception is running
 * throughout. So this must not blanket the arena — an opaque overlay hides the
 * live scores the round exists to produce, and then cuts abruptly to
 * "ANALYSING", which reads as the battle skipping its own middle.
 *
 * It is therefore a non-blocking HUD: no scrim, no pointer capture, sat in the
 * gutter between the two panels so it covers neither player.
 */
export function CountdownOverlay({ secondsRemaining }: { secondsRemaining: number }) {
  return (
    <div className="round-timer" role="timer" aria-label={`${secondsRemaining} seconds left in the round`}>
      <span className="round-timer-eyebrow">SCORING</span>
      {/* `key` retriggers the pop animation on each tick. */}
      <strong className="round-timer-number tabular-nums" key={secondsRemaining}>
        {secondsRemaining}
      </strong>
    </div>
  );
}
