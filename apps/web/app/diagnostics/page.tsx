"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Loader2, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { probeIceCandidates, type IceProbeResult } from "@/lib/iceStats";
import type { IceCandidateType, TurnSource } from "@/lib/rtcConfig";

type Verdict = {
  tone: "good" | "warn" | "bad";
  headline: string;
  detail: string;
};

const CHECKS: { type: IceCandidateType; label: string; meaning: string }[] = [
  { type: "host", label: "HOST", meaning: "Direct connection on the same subnet." },
  { type: "srflx", label: "SRFLX / STUN", meaning: "The public address was discovered, so NAT traversal can work." },
  { type: "relay", label: "RELAY / TURN", meaning: "A relay is reachable, so the battle survives hostile networks." },
];

function buildVerdict(result: IceProbeResult): Verdict {
  const hasRelay = result.types.includes("relay");
  const hasSrflx = result.types.includes("srflx");

  if (hasRelay) {
    return {
      tone: "good",
      headline: "THIS NETWORK WILL WORK",
      detail:
        "TURN is reachable, so a video route exists even if this network blocks peer-to-peer traffic between laptops.",
    };
  }
  if (hasSrflx) {
    return {
      tone: "warn",
      headline: "PROBABLY FINE, NO SAFETY NET",
      detail:
        result.turnSource === "none"
          ? "STUN works, so normal NAT traversal should succeed. No TURN relay is configured, so client isolation or a symmetric NAT would still break the connection."
          : "STUN works, so normal NAT traversal should succeed. The configured TURN relay produced no candidates, so client isolation or a symmetric NAT would still break the connection.",
    };
  }
  if (result.types.includes("host")) {
    return {
      tone: "bad",
      headline: "SAME NETWORK ONLY",
      detail:
        "Only local candidates were gathered. Both laptops must be on the same subnet, and even then client isolation would block them. Neither STUN nor TURN is reachable — use a phone hotspot or configure TURN.",
    };
  }
  return {
    tone: "bad",
    headline: "NO CANDIDATES GATHERED",
    detail:
      "WebRTC could not find any usable network path at all. Check that the browser is not blocking WebRTC and that you are not behind a restrictive VPN.",
  };
}

const TURN_SOURCE_NOTE: Record<TurnSource, string> = {
  cloudflare: "Using short-lived Cloudflare Realtime TURN credentials, minted server-side.",
  static: "Using the static TURN server from NEXT_PUBLIC_TURN_URLS.",
  none: "No TURN relay is configured. Set CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN in .env.local — see .env.example.",
};

const TONE_ICON = {
  good: ShieldCheck,
  warn: ShieldAlert,
  bad: ShieldX,
} as const;

export default function DiagnosticsPage() {
  const [result, setResult] = useState<IceProbeResult | null>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setFailure(null);
    setResult(null);
    try {
      setResult(await probeIceCandidates());
    } catch {
      setFailure("The browser refused to open a peer connection. WebRTC may be disabled by an extension or policy.");
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const verdict = result ? buildVerdict(result) : null;
  const VerdictIcon = verdict ? TONE_ICON[verdict.tone] : null;

  return (
    <main className="diagnostics-shell">
      <div className="ambient ambient-one" />

      <nav className="landing-nav">
        <Link href="/" className="wordmark">FITTED<span>®</span></Link>
        <div className="nav-status"><i /> NETWORK CHECK</div>
      </nav>

      <section className="diagnostics-body">
        <header className="diagnostics-head">
          <span className="eyebrow-plain">PREFLIGHT</span>
          <h1>WILL THIS NETWORK<br />CARRY A BATTLE?</h1>
          <p>
            Gathers ICE candidates exactly the way a real battle does, without needing a
            second laptop. Run it on the network you plan to demo on.
          </p>
        </header>

        {running && (
          <div className="diagnostics-status"><Loader2 className="spin" aria-hidden="true" /> GATHERING CANDIDATES…</div>
        )}

        {failure && (
          <div className="error-banner"><b>CHECK FAILED</b><span>{failure}</span></div>
        )}

        {verdict && VerdictIcon && (
          <div className={`verdict verdict-${verdict.tone}`}>
            <VerdictIcon aria-hidden="true" />
            <div>
              <b>{verdict.headline}</b>
              <span>{verdict.detail}</span>
            </div>
          </div>
        )}

        {result && (
          <ul className="check-list">
            {CHECKS.map((check) => {
              const found = result.types.includes(check.type);
              return (
                <li key={check.type} className={found ? "is-found" : ""}>
                  <span className="check-dot" aria-hidden="true" />
                  <b>{check.label}</b>
                  <span className="check-state">{found ? "AVAILABLE" : "NOT AVAILABLE"}</span>
                  <small>{check.meaning}</small>
                </li>
              );
            })}
          </ul>
        )}

        {result && result.errors.length > 0 && (
          <div className="probe-errors">
            <b>SERVERS THAT DID NOT RESPOND</b>
            <ul>{result.errors.map((message) => <li key={message}>{message}</li>)}</ul>
          </div>
        )}

        {result && (
          <p className="probe-note">
            {result.configError
              ? "A TURN relay is configured but credentials could not be obtained, so this check ran without one."
              : TURN_SOURCE_NOTE[result.turnSource]}
            {result.timedOut && " Gathering hit the timeout, so results may be incomplete."}
          </p>
        )}

        {result?.configError && (
          <div className="probe-errors">
            <b>TURN CREDENTIALS FAILED</b>
            <ul><li>{result.configError}</li></ul>
          </div>
        )}

        <div className="diagnostics-actions">
          <Button variant="bare" size="bare" className="secondary-action" onClick={() => void run()} disabled={running}>
            <b>{running ? "CHECKING…" : "RUN AGAIN"}</b>
          </Button>
          <Link href="/" className="back-link"><ArrowLeft aria-hidden="true" /> BACK</Link>
        </div>
      </section>
    </main>
  );
}
