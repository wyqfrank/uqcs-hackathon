export type IceCandidateType = "host" | "srflx" | "prflx" | "relay";

export type IceRoute = {
  local: IceCandidateType;
  remote: IceCandidateType;
  protocol: string;
};

/** Where the TURN relay in the active configuration came from. */
export type TurnSource = "cloudflare" | "static" | "none";

export type ResolvedIceConfig = {
  configuration: RTCConfiguration;
  turnSource: TurnSource;
  /** Set when TURN was configured but could not be obtained. */
  error: string | null;
};

const STUN_SERVERS: RTCIceServer[] = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "stun:stun1.l.google.com:19302",
    ],
  },
];

/**
 * A self-hosted or static-credential relay, if one is set. Cloudflare issues
 * expiring credentials instead, so those are minted server-side and fetched
 * from /api/turn-credentials rather than inlined here.
 */
function staticTurnServers(): RTCIceServer[] {
  // Next.js inlines NEXT_PUBLIC_* only when referenced as a static property.
  const urls = (process.env.NEXT_PUBLIC_TURN_URLS ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const username = (process.env.NEXT_PUBLIC_TURN_USERNAME ?? "").trim();
  const credential = (process.env.NEXT_PUBLIC_TURN_CREDENTIAL ?? "").trim();

  if (!urls.length || !username || !credential) return [];
  return [{ urls, username, credential }];
}

export const HAS_STATIC_TURN = staticTurnServers().length > 0;

function buildConfiguration(turnServers: RTCIceServer[]): RTCConfiguration {
  return {
    iceServers: [...STUN_SERVERS, ...turnServers],
    // Left at 0 deliberately. A pool pre-gathers candidates when the connection
    // is constructed, which allocates one TURN relay per pooled slot before any
    // call exists — quota spent on connections that may never be used, for a
    // setup saving of a few hundred milliseconds.
    iceCandidatePoolSize: 0,
  };
}

type CredentialsResponse = {
  iceServers: RTCIceServer[];
  source: "cloudflare" | "none";
  error: string | null;
};

/** Set NEXT_PUBLIC_DISABLE_TURN=1 to test on a known-good network without
 *  allocating relays. Direct connections are unaffected; only the safety net
 *  is removed, so never ship a build with this set. */
const TURN_DISABLED = (process.env.NEXT_PUBLIC_DISABLE_TURN ?? "") === "1";

async function resolve(): Promise<ResolvedIceConfig> {
  let cloudflareError: string | null = null;

  if (TURN_DISABLED) {
    return { configuration: buildConfiguration([]), turnSource: "none", error: null };
  }

  try {
    const response = await fetch("/api/turn-credentials", { cache: "no-store" });
    if (response.ok) {
      const payload = (await response.json()) as CredentialsResponse;
      if (payload.iceServers.length) {
        return {
          configuration: buildConfiguration(payload.iceServers),
          turnSource: "cloudflare",
          error: null,
        };
      }
      cloudflareError = payload.error;
    }
  } catch {
    cloudflareError = "The TURN credential endpoint could not be reached.";
  }

  const fallback = staticTurnServers();
  if (fallback.length) {
    return { configuration: buildConfiguration(fallback), turnSource: "static", error: null };
  }

  return {
    configuration: buildConfiguration([]),
    turnSource: "none",
    error: cloudflareError,
  };
}

let pending: Promise<ResolvedIceConfig> | null = null;

/**
 * Resolves the ICE configuration once per page load. Credentials are cached
 * server-side and long-lived relative to a battle, so a single fetch is enough.
 */
export function getIceConfig(): Promise<ResolvedIceConfig> {
  pending ??= resolve();
  return pending;
}

/** Discards the cached configuration so the next call re-mints credentials. */
export function refreshIceConfig(): Promise<ResolvedIceConfig> {
  pending = resolve();
  return pending;
}

export const CANDIDATE_TYPE_LABELS: Record<IceCandidateType, string> = {
  host: "DIRECT",
  srflx: "P2P VIA NAT",
  prflx: "P2P VIA NAT",
  relay: "TURN RELAY",
};

export function describeRoute(route: IceRoute | null): string | null {
  if (!route) return null;
  // The relayed side is the one that matters: if either end is a relay, media
  // is going through TURN.
  const relayed = route.local === "relay" || route.remote === "relay";
  if (relayed) return `${CANDIDATE_TYPE_LABELS.relay} / ${route.protocol.toUpperCase()}`;
  return `${CANDIDATE_TYPE_LABELS[route.local]} / ${route.protocol.toUpperCase()}`;
}
