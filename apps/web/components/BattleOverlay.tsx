"use client";

import type { ReactNode } from "react";

/**
 * Dimmed full-arena overlay for the final result. The scrim is heavy because
 * the battle is over at this point — during the round the timer deliberately
 * does not cover the feeds (see CountdownOverlay).
 */
export function BattleOverlay({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="battle-overlay" role="dialog" aria-modal="false" aria-label={label}>
      <div className="battle-overlay-panel">{children}</div>
    </div>
  );
}
