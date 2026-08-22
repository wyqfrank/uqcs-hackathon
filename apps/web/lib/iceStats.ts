import {
  refreshIceConfig,
  type IceCandidateType,
  type IceRoute,
  type TurnSource,
} from "@/lib/rtcConfig";

type CandidatePairReport = {
  type: string;
  state?: string;
  nominated?: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
};

type CandidateReport = {
  candidateType?: IceCandidateType;
  protocol?: string;
};

/**
 * Reads the candidate pair WebRTC actually settled on, which is the only
 * reliable way to tell a direct connection from a TURN-relayed one.
 */
export async function readActiveRoute(
  peer: RTCPeerConnection,
): Promise<IceRoute | null> {
  const stats = await peer.getStats();
  let selected: CandidatePairReport | null = null;

  stats.forEach((report: unknown) => {
    const pair = report as CandidatePairReport;
    if (pair.type !== "candidate-pair" || pair.state !== "succeeded") return;
    // Firefox omits `nominated`; treat a succeeded pair as authoritative there.
    if (pair.nominated === false) return;
    selected = pair;
  });

  if (!selected) return null;
  const pair: CandidatePairReport = selected;

  const local = stats.get(pair.localCandidateId ?? "") as CandidateReport | undefined;
  const remote = stats.get(pair.remoteCandidateId ?? "") as CandidateReport | undefined;
  if (!local?.candidateType || !remote?.candidateType) return null;

  return {
    local: local.candidateType,
    remote: remote.candidateType,
    protocol: local.protocol ?? "udp",
  };
}

export type IceProbeResult = {
  types: IceCandidateType[];
  errors: string[];
  timedOut: boolean;
  turnSource: TurnSource;
  configError: string | null;
};

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Gathers local ICE candidates without needing a second peer. The set of types
 * that come back tells you what this network will allow before you rely on it:
 * `host` only means same-subnet connections just, `srflx` means STUN traversal
 * works, and `relay` means TURN is reachable and the demo survives anything.
 */
export async function probeIceCandidates(): Promise<IceProbeResult> {
  // Re-mint rather than reuse, so the probe reports the state of the credential
  // path as it is right now — that is the whole point of running it on site.
  const { configuration, turnSource, error: configError } = await refreshIceConfig();
  const peer = new RTCPeerConnection(configuration);
  const types = new Set<IceCandidateType>();
  const errors = new Set<string>();
  let timedOut = false;

  try {
    // A data channel gives ICE something to gather for; no media needed.
    peer.createDataChannel("probe");

    const gathering = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, PROBE_TIMEOUT_MS);

      const finish = () => {
        clearTimeout(timer);
        resolve();
      };

      peer.onicecandidate = ({ candidate }) => {
        if (!candidate) {
          finish();
          return;
        }
        if (candidate.type) types.add(candidate.type as IceCandidateType);
      };

      peer.onicegatheringstatechange = () => {
        if (peer.iceGatheringState === "complete") finish();
      };

      peer.onicecandidateerror = (event) => {
        const { errorCode, errorText, url } = event as RTCPeerConnectionIceErrorEvent;
        // 701 is the generic "STUN/TURN server unreachable" bucket.
        errors.add(`${url || "unknown server"} — ${errorText || "unreachable"} (${errorCode})`);
      };
    });

    await peer.setLocalDescription(await peer.createOffer());
    await gathering;
  } finally {
    peer.close();
  }

  return { types: [...types], errors: [...errors], timedOut, turnSource, configError };
}
