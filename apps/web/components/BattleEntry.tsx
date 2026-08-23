"use client";

import { useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, Trophy } from "lucide-react";
import Link from "next/link";
import { BattleRoom } from "@/components/BattleRoom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RoomRole } from "@/lib/signaling";

const MAX_NAME_LENGTH = 24;

/**
 * Collects the player's name before the battle starts.
 *
 * The name is deliberately not remembered between battles: a hackathon laptop is
 * shared, so the next person to sit down would otherwise inherit the last
 * player's record.
 */
export function BattleEntry({ roomId, role }: { roomId: string; role: RoomRole }) {
  const [name, setName] = useState("");
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [error, setError] = useState("");

  if (confirmed !== null) {
    return <BattleRoom roomId={roomId} role={role} playerName={confirmed} />;
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim().replace(/\s+/g, " ");
    if (!trimmed) {
      setError("Enter a name so your wins are recorded.");
      return;
    }
    setConfirmed(trimmed);
  };

  return (
    <main className="landing-shell">
      <div className="ambient ambient-one" />

      <nav className="landing-nav">
        <Link href="/" className="wordmark">FITTED<span>®</span></Link>
        <div className="nav-status"><i /> ROOM {roomId}</div>
      </nav>

      <section className="hero name-gate">
        {/* Reached by typing a room code, so changing your mind needs an exit
            that is not just the wordmark. The battle itself has LEAVE. */}
        <Link href="/" className="back-link gate-back">
          <ArrowLeft aria-hidden="true" /> BACK
        </Link>
        <div className="eyebrow"><Trophy aria-hidden="true" /> WHO&apos;S PLAYING?</div>
        <h1>NAME<br /><em>YOURSELF</em></h1>
        <p>
          Your wins and best score are saved against this name.
          Use the same one each time to build a record.
        </p>

        <form className="name-form" onSubmit={submit}>
          <label htmlFor="player-name">PLAYER NAME</label>
          <Input
            id="player-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
            placeholder="e.g. Angus"
            maxLength={MAX_NAME_LENGTH}
            autoFocus
            autoComplete="off"
          />
          <Button variant="bare" size="bare" className="primary-action" type="submit">
            <b>ENTER BATTLE</b>
            <ArrowRight aria-hidden="true" />
          </Button>
        </form>

        {error && <p className="form-error">{error}</p>}

        <Link href="/leaderboard" className="gate-link">VIEW LEADERBOARD</Link>
      </section>
    </main>
  );
}
