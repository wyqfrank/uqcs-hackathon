"use client";

import type { ReactNode } from "react";

/**
 * Shared shell for the two full-arena moments: the opening countdown and the
 * final result. One component so the scrim, entrance and stacking stay
 * identical rather than drifting apart.
 *
 * `tone` controls how much of the battle stays visible behind it:
 *   "light" — countdown; players still need to frame themselves
 *   "heavy" — result; the battle is over, so the verdict takes the screen
 */
export function BattleOverlay({
  tone,
  label,
  children,
}: {
  tone: "light" | "heavy";
  label: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`battle-overlay is-${tone}`}
      role="dialog"
      aria-modal="false"
      aria-label={label}
    >
      <div className="battle-overlay-panel">{children}</div>
    </div>
  );
}
