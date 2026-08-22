"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BattleScoringState } from "@/lib/scoring";
import { SCENARIOS } from "./scenarios";

/**
 * Plays a whole round against the clock: readiness, lead-in, the scored
 * window, collection, analysis, result.
 *
 * The static scenarios show what each phase looks like. This shows how the
 * round *feels* — whether the lead-in is long enough to settle into frame,
 * and whether the cut from scoring to analysing lands or jars. Those are the
 * questions a still frame cannot answer, and the reason the phase durations
 * here mirror the server's real defaults.
 */

/** Server defaults: FITTED_ROUND_LEAD_IN_MS and FITTED_ROUND_DURATION_MS. */
export const LEAD_IN_MS = 3000;
export const ROUND_MS = 5000;
const COLLECTING_MS = 900;
const ANALYSING_MS = 1800;
const TICK_MS = 100;

const FINAL = SCENARIOS.find((s) => s.id === "final-win")!.state;

export type SimulatedRound = {
  running: boolean;
  state: BattleScoringState;
  /** Live estimates, drifting during the scored window. */
  scores: [number, number] | null;
  provisional: boolean;
  start: () => void;
  stop: () => void;
};

export function useSimulatedRound(): SimulatedRound {
  const [running, setRunning] = useState(false);
  const [state, setState] = useState<BattleScoringState>({
    phase: "waiting_ready", playerAReady: false, playerBReady: false,
  });
  const [scores, setScores] = useState<[number, number] | null>(null);
  const timers = useRef<number[]>([]);
  const ticker = useRef<number | null>(null);

  const clear = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    if (ticker.current !== null) window.clearInterval(ticker.current);
    ticker.current = null;
  }, []);

  const stop = useCallback(() => {
    clear();
    setRunning(false);
    setScores(null);
    setState({ phase: "waiting_ready", playerAReady: false, playerBReady: false });
  }, [clear]);

  const start = useCallback(() => {
    clear();
    setRunning(true);
    setScores(null);
    setState({ phase: "waiting_ready", playerAReady: false, playerBReady: false });

    const at = (ms: number, run: () => void) => {
      timers.current.push(window.setTimeout(run, ms));
    };

    // Readiness lands one player at a time, as it does in a real room.
    at(500, () => setState({ phase: "waiting_ready", playerAReady: true, playerBReady: false }));
    at(1100, () => setState({ phase: "waiting_ready", playerAReady: true, playerBReady: true }));

    const leadInStart = 1400;
    at(leadInStart, () => {
      const deadline = performance.now() + LEAD_IN_MS;
      ticker.current = window.setInterval(() => {
        const remaining = Math.max(0, deadline - performance.now());
        setState({ phase: "starting", roundId: "sim", secondsRemaining: Math.ceil(remaining / 1000) });
      }, TICK_MS);
    });

    const roundStart = leadInStart + LEAD_IN_MS;
    at(roundStart, () => {
      if (ticker.current !== null) window.clearInterval(ticker.current);
      const deadline = performance.now() + ROUND_MS;
      // Scores wander rather than sitting still, so the meters actually move.
      let a = 71 + Math.random() * 4;
      let b = 69 + Math.random() * 4;
      ticker.current = window.setInterval(() => {
        const remaining = Math.max(0, deadline - performance.now());
        a = Math.min(96, Math.max(50, a + (Math.random() - 0.45) * 1.6));
        b = Math.min(96, Math.max(50, b + (Math.random() - 0.45) * 1.6));
        setScores([a, b]);
        setState({ phase: "countdown", roundId: "sim", secondsRemaining: Math.ceil(remaining / 1000) });
      }, TICK_MS);
    });

    const collectStart = roundStart + ROUND_MS;
    at(collectStart, () => {
      if (ticker.current !== null) window.clearInterval(ticker.current);
      ticker.current = null;
      setState({ phase: "collecting", finalisationId: "sim-f" });
    });
    at(collectStart + COLLECTING_MS, () => setState({ phase: "analysing", finalisationId: "sim-f" }));
    at(collectStart + COLLECTING_MS + ANALYSING_MS, () => {
      setScores(null);
      setState(FINAL);
      setRunning(false);
    });
  }, [clear]);

  useEffect(() => clear, [clear]);

  return {
    running,
    state,
    scores,
    provisional: state.phase === "countdown",
    start,
    stop,
  };
}
