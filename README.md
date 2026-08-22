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

This installs the npm workspace and the Python service with its development tools.
Large ML libraries are intentionally optional. Install them only when working on
the model implementation:

```powershell
.venv\Scripts\python -m pip install -e "services/inference[dev,ml]"
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
The inference scaffold reports healthy but deliberately returns `503` for
comparisons until an evaluated model is connected.

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

## Architecture notes

- `apps/web/server.mjs` hosts Next.js and the Socket.IO signalling server together.
- `apps/web/hooks/useCamera.ts` owns local camera lifecycle.
- `apps/web/hooks/useWebRTC.ts` owns the peer connection and remote stream.
- `apps/web/lib/scoring.ts` is still the replaceable client-side placeholder.
- `services/inference/src/fitted_inference/engine.py` is the model-loading and paired
  inference boundary. Models should load once during FastAPI startup.
- Training datasets, model weights, checkpoints, and experiment output are ignored;
  store them outside Git or in a dedicated artifact store.

See [docs/PRD.md](docs/PRD.md) for product scope and
[services/inference/README.md](services/inference/README.md) for the API contract.
