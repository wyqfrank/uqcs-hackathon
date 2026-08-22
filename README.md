# FITTED — live fashion battle

FITTED is a two-player, webcam-first fashion battle. The repository is a small
monorepo with an independently deployable web application and Python inference
service.

```text
apps/web/                    Next.js UI, Socket.IO signalling, WebRTC
services/inference/          FastAPI service and online ML boundary
docs/                        Product requirements and focused specifications
scripts/                     Repository-wide developer tooling
```

The browser-to-browser video remains peer-to-peer over WebRTC. Socket.IO carries
room and signalling messages only. The Python service receives sampled image pairs
for scoring; it never sits in the live video path.

## Prerequisites

- Node.js 22 or newer
- Python 3.11 or newer

## Set up

From the repository root:

```powershell
npm run setup
```

This installs the npm workspace, Python development tools, and the lightweight
Gemini VLM client used by final scoring. Large local ML libraries remain optional;
install them only when working on local garment or encoder experiments:

```powershell
.venv\Scripts\python -m pip install -e "services/inference[dev,ml]"
```

For the CUDA RF-DETR garment lane, install the tested `rf` extra after selecting
the CUDA-enabled PyTorch wheel appropriate for the demo laptop:

```powershell
.venv\Scripts\python -m pip install -e "services/inference[dev,rf]"
```

## Run locally

```powershell
npm run dev
```

This starts:

- web and signalling server: `http://localhost:3000`
- inference API: `http://localhost:8000`
- inference OpenAPI docs: `http://localhost:8000/docs`

Run either process independently with `npm run dev:web` or `npm run dev:api`.
Set `GEMINI_API_KEY` and `FITTED_SCORING_BACKEND=vlm_fallback` before starting the
services to enable final comparison. Without them, the inference service remains
healthy but explicitly reports its comparison model as unavailable.

## Useful commands

```powershell
npm run typecheck       # TypeScript
npm run test            # frontend and backend tests
npm run lint:api        # Python lint
npm run build           # production Next.js build
npm run check           # all of the above
```

## Run on two laptops

Camera access requires HTTPS when the site is opened from another device. An address
such as `http://192.168.1.20:3000` is not a secure context, so the second browser will
block camera access.

For a hackathon demo, start the app on Laptop A and expose it through an HTTPS tunnel:

```powershell
npm run dev
cloudflared tunnel --url http://localhost:3000
```

Open the generated `https://...trycloudflare.com` URL on both laptops. For LAN-only
HTTPS, provide trusted certificate paths before starting the app:

```powershell
$env:SSL_KEY_PATH="C:\path\to\192.168.1.20-key.pem"
$env:SSL_CERT_PATH="C:\path\to\192.168.1.20.pem"
npm run dev:web
```

Both devices must trust the certificate authority. Allow inbound TCP port 3000 in
Laptop A's firewall if prompted.

## Network preflight and TURN

Guest and campus Wi-Fi can block peer-to-peer traffic through client isolation,
symmetric NAT, or an outright UDP block. Run the command-line preflight on the
network before relying on it:

```powershell
npm run test:turn
```

Then open `/diagnostics` in the browser. It gathers ICE candidates without a
second laptop:

- `host` only means both laptops need a shared subnet and client isolation can
  still block them;
- `srflx` means STUN traversal works through an ordinary NAT;
- `relay` means TURN is reachable and provides the safest demo route.

The battle status strip reports the negotiated route as `DIRECT`, `P2P VIA NAT`,
or `TURN RELAY`.

For Cloudflare Realtime TURN, copy `apps/web/.env.example` to
`apps/web/.env.local` and set `CLOUDFLARE_TURN_KEY_ID` and
`CLOUDFLARE_TURN_API_TOKEN`. The server exchanges these secrets for short-lived
credentials; the API token never reaches the browser. A self-hosted relay can
instead use the documented `NEXT_PUBLIC_TURN_*` values, but those static
credentials are visible in the browser bundle.

TURN is a fallback, not the preferred route, so a healthy direct connection does
not consume relay bandwidth. If no relay is available, putting both laptops on
one phone hotspot is the most reliable fallback.

## Architecture notes

- `apps/web/server.mjs` hosts Next.js and the Socket.IO signalling server together.
- `apps/web/hooks/useCamera.ts` owns local camera lifecycle.
- `apps/web/hooks/useWebRTC.ts` owns signalling, the peer connection, camera-track
  replacement, and the remote stream.
- `apps/web/lib/iceStats.ts` reports gathered candidates and the active WebRTC route.
- `apps/web/lib/rtcConfig.ts` resolves STUN and TURN configuration.
- `apps/web/lib/scoring.ts` defines the authoritative final-result client contract.
- `apps/web/server.mjs` pairs one local crop from each player and invokes inference
  once per finalisation.
- The same room coordinator requests paired garment crops at approximately 1 Hz,
  permits one request in flight, and pauses that lane during finalisation.
- `services/inference/src/fitted_inference/engine.py` is the model-loading and paired
  inference boundary. Models should load once during FastAPI startup.
- Training datasets, model weights, checkpoints, and experiment output are ignored;
  store them outside Git or in a dedicated artifact store.

See [docs/PRD.md](docs/PRD.md) for product scope and
[services/inference/README.md](services/inference/README.md) for the API contract.
