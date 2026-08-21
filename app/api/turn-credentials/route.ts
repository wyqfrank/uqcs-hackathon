/**
 * Mints short-lived Cloudflare Realtime TURN credentials.
 *
 * Cloudflare does not issue static TURN credentials, so they cannot live in
 * NEXT_PUBLIC_* like a self-hosted relay's would. The API token stays on the
 * server and only the derived, expiring username/credential reaches the browser.
 */
export const dynamic = "force-dynamic";

const CREDENTIAL_TTL_SECONDS = 12 * 60 * 60;
// Re-mint slightly early so a battle never starts with a credential about to die.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

type TurnCredentialsResponse = {
  iceServers: RTCIceServer[];
  source: "cloudflare" | "none";
  error: string | null;
};

type CloudflarePayload = {
  iceServers?: RTCIceServer | RTCIceServer[];
};

let cached: { iceServers: RTCIceServer[]; expiresAt: number } | null = null;

function json(body: TurnCredentialsResponse, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function GET() {
  const keyId = (process.env.CLOUDFLARE_TURN_KEY_ID ?? "").trim();
  const apiToken = (process.env.CLOUDFLARE_TURN_API_TOKEN ?? "").trim();

  if (!keyId || !apiToken) {
    return json({ iceServers: [], source: "none", error: null });
  }

  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return json({ iceServers: cached.iceServers, source: "cloudflare", error: null });
  }

  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
        cache: "no-store",
      },
    );

    if (!response.ok) {
      // Cloudflare's body describes the problem (bad key id, expired token) and
      // never echoes the token itself, so it is safe to surface.
      const detail = (await response.text()).slice(0, 300);
      return json({
        iceServers: [],
        source: "none",
        error: `Cloudflare rejected the TURN request (${response.status}). ${detail}`,
      });
    }

    const payload = (await response.json()) as CloudflarePayload;
    // The API has returned both a single object and an array across versions.
    const iceServers = payload.iceServers
      ? Array.isArray(payload.iceServers)
        ? payload.iceServers
        : [payload.iceServers]
      : [];

    if (!iceServers.length) {
      return json({
        iceServers: [],
        source: "none",
        error: "Cloudflare returned no ICE servers.",
      });
    }

    cached = { iceServers, expiresAt: Date.now() + CREDENTIAL_TTL_SECONDS * 1000 };
    return json({ iceServers, source: "cloudflare", error: null });
  } catch (caughtError) {
    const message = caughtError instanceof Error ? caughtError.message : "unknown error";
    return json({
      iceServers: [],
      source: "none",
      error: `Could not reach Cloudflare to mint TURN credentials: ${message}`,
    });
  }
}
