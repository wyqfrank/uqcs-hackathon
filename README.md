# FITTED — live fashion battle

A two-player, webcam-first fashion battle built with Next.js, React, TypeScript, WebRTC, Socket.IO, and Tailwind CSS. Socket.IO carries signalling messages only; both video feeds travel directly between the two browsers over WebRTC.

## Run locally

```powershell
npm install
npm run dev
```

Open `http://localhost:3000` on the host laptop. `localhost` is a secure-context exception in modern browsers, so its webcam will work during local development.

## Run on two laptops (recommended)

Camera access requires HTTPS when the page is opened from another device. An address such as `http://192.168.1.20:3000` is **not** considered secure and the second laptop's browser will block `getUserMedia()`.

The fastest hackathon setup is an HTTPS tunnel:

1. On Laptop A, run `npm run dev`.
2. Install [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), then run:

   ```powershell
   cloudflared tunnel --url http://localhost:3000
   ```

3. Open the generated `https://...trycloudflare.com` URL on both laptops.
4. Laptop A clicks **Create Battle**, allows camera access, and sends the displayed `FIT-####` code to Laptop B.
5. Laptop B clicks **Join Battle**, enters the code, and allows camera access.

For a LAN-only HTTPS setup, create a certificate containing Laptop A's LAN IP with `mkcert`, trust the generated local CA on both laptops, and start the app with the certificate paths:

```powershell
$env:SSL_KEY_PATH="C:\path\to\192.168.1.20-key.pem"
$env:SSL_CERT_PATH="C:\path\to\192.168.1.20.pem"
npm run dev
```

Then both users open `https://192.168.1.20:3000`. Allow inbound TCP port 3000 in Laptop A's firewall if prompted. Both devices must trust the certificate authority; clicking through a certificate warning is not sufficient for dependable camera access.

## Will the venue's network work?

Two laptops connect directly over WebRTC, so the network has to permit peer-to-peer
traffic. Guest and campus wifi frequently does not. Three separate things can break it:

| Failure | Symptom | Fix |
|---|---|---|
| Client isolation (the AP blocks laptop-to-laptop traffic) | Signalling connects, video never arrives | TURN |
| Symmetric NAT | Same as above | TURN |
| UDP blocked entirely | Same as above | TURN over TCP/443 |

Run the preflight on the network **before** you rely on it:

```powershell
npm run test:turn        # STUN/TURN reachability from the CLI
```

Then open `/diagnostics` in the browser. It gathers ICE candidates exactly the way a
real battle does, without needing a second laptop, and reports which candidate types
this network allows:

- `host` only — both laptops must share a subnet, and client isolation still breaks it
- `+ srflx` — STUN traversal works, normal NATs are fine
- `+ relay` — TURN is reachable, the demo survives essentially any network

Once a battle is live, the nav strip shows the route actually negotiated (`DIRECT`,
`P2P VIA NAT`, or `TURN RELAY`), so a relayed connection is never a silent surprise.

### Configuring TURN

There is no built-in TURN fallback on purpose: the well-known free public relays
(`openrelay.metered.ca` and friends) still resolve in DNS but no longer answer, so
shipping one would look like a safety net while providing none.

**Cloudflare Realtime (preferred).** Create a TURN key in the Cloudflare dashboard
under Realtime → TURN, then set both values in `.env.local`:

```powershell
CLOUDFLARE_TURN_KEY_ID=...
CLOUDFLARE_TURN_API_TOKEN=...
```

These are deliberately *not* `NEXT_PUBLIC_*`. Cloudflare issues short-lived
credentials, so [`app/api/turn-credentials/route.ts`](app/api/turn-credentials/route.ts)
mints an expiring username/credential pair server-side and only that reaches the
browser. The API token never leaves the server.

**Static credentials.** For a self-hosted `coturn` or any provider issuing long-lived
credentials, set `NEXT_PUBLIC_TURN_*` instead — used only when Cloudflare is not
configured. Include a `?transport=tcp` entry on port 443 so the relay survives
networks that block UDP. Note these are visible in the browser bundle, so anyone can
spend the relay quota.

ICE only falls back to TURN as a last resort, so on a healthy network the relay costs
nothing. That matters, because relayed 720p burns a bandwidth quota quickly.

If TURN is not an option, a **phone hotspot is the reliable fallback**: both laptops
land on one subnet behind one NAT, so they connect on `host` candidates without
needing traversal at all.

## How it works

- **Room flow:** The creator generates a short `FIT-####` ID in the browser. The signalling server admits one host and one guest, rejects missing/full rooms, and notifies the host when the challenger arrives.
- **WebRTC:** The host creates an SDP offer after `peer-joined`. The guest applies it and returns an SDP answer. Both sides exchange ICE candidates through Socket.IO. The server never receives media.
- **Route reporting:** `readActiveRoute()` in [`lib/iceStats.ts`](lib/iceStats.ts) polls `getStats()` for the succeeded candidate pair, which is the only reliable way to tell a direct connection from a relayed one. An exhausted ICE negotiation surfaces as `failed` rather than being folded into `disconnected`, so a network problem reads differently from an opponent who left.
- **Streams:** `useCamera` owns one local `MediaStream`, handles permission/error states, and safely stops tracks on exit. `useWebRTC` owns the `RTCPeerConnection`; its `ontrack` callback stores the remote `MediaStream`. `PlayerCard` assigns each stream to its own video element.
- **Frame extraction:** `captureVideoFrame()` draws either video element into a resized offscreen canvas and returns an encoded WebP `Blob`. Local and remote elements are sampled independently; no inference frame is sent over the signalling channel.
- **ML integration:** Replace the body of `inferFrame()` in [`lib/scoring.ts`](lib/scoring.ts). Its input and output already match the intended `Blob -> FittedResult` boundary.
- **Backpressure:** `useInference` runs a 250 ms sampling timer with an `inferenceRunningRef` lock. If a previous call is still running, the tick is skipped—there is no promise queue and therefore no stale-frame backlog. The next available tick captures the newest visible frame.
- **Smoothing:** Scores use an exponential moving average with `alpha = 0.2`. Winner comparison is isolated in `determineWinner()`, with a two-point draw threshold.

## Production build

```powershell
npm run typecheck
npm run build
npm start
```

The isolated ICE configuration lives in [`lib/rtcConfig.ts`](lib/rtcConfig.ts) and reads
TURN credentials from the environment. See [Will the venue's network work?](#will-the-venues-network-work)
before demoing anywhere unfamiliar.
