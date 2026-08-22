"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Loader2, RotateCw, Trophy } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { LeaderboardEntry } from "@/lib/leaderboard.mjs";

const REFRESH_MS = 10000;
const RANK_LABELS = ["1ST", "2ND", "3RD"];

export default function LeaderboardPage() {
  const [standings, setStandings] = useState<LeaderboardEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/leaderboard", { cache: "no-store" });
      const payload = (await response.json()) as {
        standings: LeaderboardEntry[];
        error?: string;
      };
      if (payload.error) setError(payload.error);
      else setError(null);
      setStandings(payload.standings);
    } catch {
      setError("Could not reach the leaderboard. Is the battle server running?");
      setStandings((current) => current ?? []);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Battles finish while this is open on a spare screen, so keep it current.
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <main className="diagnostics-shell">
      <div className="ambient ambient-one" />

      <nav className="landing-nav">
        <Link href="/" className="wordmark">FITTED<span>®</span></Link>
        <div className="nav-status"><i /> LEADERBOARD</div>
      </nav>

      <section className="diagnostics-body">
        <header className="diagnostics-head">
          <span className="eyebrow-plain">HALL OF FAME</span>
          <h1>WHO&apos;S MOST<br />FITTED?</h1>
          <p>Ranked by wins, then best score. Updates automatically as battles finish.</p>
        </header>

        {standings === null && (
          <div className="diagnostics-status"><Loader2 className="spin" aria-hidden="true" /> LOADING STANDINGS…</div>
        )}

        {error && (
          <div className="error-banner"><b>LEADERBOARD UNAVAILABLE</b><span>{error}</span></div>
        )}

        {standings?.length === 0 && !error && (
          <div className="empty-board">
            <Trophy aria-hidden="true" />
            <b>NO BATTLES YET</b>
            <span>Finish a battle and the winner appears here.</span>
          </div>
        )}

        {standings && standings.length > 0 && (
          <ol className="board">
            <li className="board-head">
              <span>RANK</span>
              <span>PLAYER</span>
              <span>WINS</span>
              <span>BEST</span>
              <span>PLAYED</span>
            </li>
            {standings.map((entry, index) => (
              <li key={entry.name} className={index < 3 ? `board-row is-podium rank-${index + 1}` : "board-row"}>
                <span className="board-rank">{RANK_LABELS[index] ?? `${index + 1}TH`}</span>
                <span className="board-name">{entry.name}</span>
                <span className="board-wins tabular-nums">{entry.wins}</span>
                <span className="board-best tabular-nums">{entry.highestScore.toFixed(1)}</span>
                <span className="board-played tabular-nums">{entry.battles}</span>
              </li>
            ))}
          </ol>
        )}

        <div className="diagnostics-actions">
          <Button
            variant="bare"
            size="bare"
            className="secondary-action"
            onClick={() => void load()}
            disabled={refreshing}
          >
            <span><RotateCw aria-hidden="true" className={refreshing ? "spin" : undefined} /></span>
            <b>{refreshing ? "REFRESHING…" : "REFRESH"}</b>
          </Button>
          <Link href="/" className="back-link"><ArrowLeft aria-hidden="true" /> BACK</Link>
        </div>
      </section>
    </main>
  );
}
