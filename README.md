# MOG — live fashion battle

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
4. Laptop A clicks **Create Battle**, allows camera access, and sends the displayed `MOG-####` code to Laptop B.
5. Laptop B clicks **Join Battle**, enters the code, and allows camera access.

For a LAN-only HTTPS setup, create a certificate containing Laptop A's LAN IP with `mkcert`, trust the generated local CA on both laptops, and start the app with the certificate paths:

```powershell
$env:SSL_KEY_PATH="C:\path\to\192.168.1.20-key.pem"
$env:SSL_CERT_PATH="C:\path\to\192.168.1.20.pem"
npm run dev
```

Then both users open `https://192.168.1.20:3000`. Allow inbound TCP port 3000 in Laptop A's firewall if prompted. Both devices must trust the certificate authority; clicking through a certificate warning is not sufficient for dependable camera access.

## How it works

- **Room flow:** The creator generates a short `MOG-####` ID in the browser. The signalling server admits one host and one guest, rejects missing/full rooms, and notifies the host when the challenger arrives.
- **WebRTC:** The host creates an SDP offer after `peer-joined`. The guest applies it and returns an SDP answer. Both sides exchange ICE candidates through Socket.IO. The server never receives media.
- **Streams:** `useCamera` owns one local `MediaStream`, handles permission/error states, and safely stops tracks on exit. `useWebRTC` owns the `RTCPeerConnection`; its `ontrack` callback stores the remote `MediaStream`. `PlayerCard` assigns each stream to its own video element.
- **Frame extraction:** `captureVideoFrame()` draws either video element into a resized offscreen canvas and returns an encoded WebP `Blob`. Local and remote elements are sampled independently; no inference frame is sent over the signalling channel.
- **ML integration:** Replace the body of `inferFrame()` in [`lib/scoring.ts`](lib/scoring.ts). Its input and output already match the intended `Blob -> MogResult` boundary.
- **Backpressure:** `useInference` runs a 250 ms sampling timer with an `inferenceRunningRef` lock. If a previous call is still running, the tick is skipped—there is no promise queue and therefore no stale-frame backlog. The next available tick captures the newest visible frame.
- **Smoothing:** Scores use an exponential moving average with `alpha = 0.2`. Winner comparison is isolated in `determineWinner()`, with a two-point draw threshold.

## Production build

```powershell
npm run typecheck
npm run build
npm start
```

The isolated ICE configuration lives in [`lib/rtcConfig.ts`](lib/rtcConfig.ts). A public STUN server is enough for the intended same-network demo; add TURN credentials there before relying on connections across restrictive NATs or enterprise networks.
