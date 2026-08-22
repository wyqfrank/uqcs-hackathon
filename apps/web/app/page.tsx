"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Plus, Swords, Trophy } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function generateRoomId() {
  return `FIT-${Math.floor(1000 + Math.random() * 9000)}`;
}

export default function LandingPage() {
  const router = useRouter();
  const [joining, setJoining] = useState(false);
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState("");

  const createBattle = () => router.push(`/room/${generateRoomId()}?mode=create`);
  const joinBattle = () => {
    if (!joining) {
      setJoining(true);
      return;
    }
    const normalized = roomCode.trim().toUpperCase();
    if (!/^FIT-\d{4}$/.test(normalized)) {
      setError("Enter a room code like FIT-4821");
      return;
    }
    router.push(`/room/${normalized}`);
  };

  return (
    <main className="landing-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <nav className="landing-nav">
        <div className="wordmark">FITTED<span>®</span></div>
        <div className="nav-status"><i /> LIVE FIT BATTLES</div>
      </nav>

      <section className="hero">
        <div className="eyebrow"><Swords /> HEAD-TO-HEAD STYLE</div>
        <h1>WHO&apos;S<br /><em>FITTED?</em></h1>
        <p>Two fits enter. One leaves iconic.<br />Start a live camera battle and settle it.</p>

        <div className="landing-actions">
          <Button variant="bare" size="bare" className="primary-action" onClick={createBattle}>
            <span><Plus aria-hidden="true" /></span>
            <b>CREATE BATTLE</b>
            <ArrowRight aria-hidden="true" />
          </Button>

          <div className={`join-panel ${joining ? "is-open" : ""}`}>
            {joining && (
              <div className="code-field-wrap">
                <label htmlFor="room-code">ROOM CODE</label>
                <Input
                  id="room-code"
                  value={roomCode}
                  onChange={(event) => {
                    setRoomCode(event.target.value.toUpperCase());
                    setError("");
                  }}
                  onKeyDown={(event) => event.key === "Enter" && joinBattle()}
                  placeholder="FIT-4821"
                  maxLength={8}
                  autoFocus
                />
              </div>
            )}
            <Button variant="bare" size="bare" className="secondary-action" onClick={joinBattle}>
              <b>{joining ? "ENTER BATTLE" : "JOIN BATTLE"}</b>
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
          {error && <p className="form-error">{error}</p>}

          <Link href="/leaderboard" className="leaderboard-link">
            <Trophy aria-hidden="true" />
            <b>VIEW LEADERBOARD</b>
            <ArrowRight aria-hidden="true" />
          </Link>
        </div>
      </section>

      <footer className="landing-footer">
        <span>01 / CAMERA ON</span><span>02 / FACE OFF</span><span>03 / GET SCORED</span>
      </footer>
    </main>
  );
}
