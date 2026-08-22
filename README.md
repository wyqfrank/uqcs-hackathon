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

## Will the venue's network work?

Two laptops connect directly over WebRTC, so the network has to permit peer-to-peer
traffic. Guest and campus wifi frequently does not. Three separate things can break it:

| Failure | Symptom | Fix |
|---|---|---|
| Client isolation (the AP blocks laptop-to-laptop traffic) | Signalling connects, video never arrives | TURN |
| Symmetric NAT | Same as above | TURN |
| UDP blocked entirely | Same as above | TURN over TCP/443 |

Run the preflight on the network **before** you rely on it:

```bash
npm run test:turn
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
under Realtime -> TURN, then set both values in `apps/web/.env.local`:

```bash
CLOUDFLARE_TURN_KEY_ID=...
CLOUDFLARE_TURN_API_TOKEN=...
```

These are deliberately *not* `NEXT_PUBLIC_*`. Cloudflare issues short-lived
credentials, so [`apps/web/app/api/turn-credentials/route.ts`](apps/web/app/api/turn-credentials/route.ts)
mints an expiring username/credential pair server-side and only that reaches the
browser. The API token never leaves the server.

**Static credentials.** For a self-hosted `coturn` or any provider issuing long-lived
credentials, set `NEXT_PUBLIC_TURN_*` instead — used only when Cloudflare is not
configured. Include a `?transport=tcp` entry on port 443 so the relay survives
networks that block UDP. Note these are visible in the browser bundle, so anyone can
spend the relay quota.

ICE prefers direct routes and only selects the relay when nothing else works, so on a
healthy network TURN costs nothing. Set `NEXT_PUBLIC_DISABLE_TURN=1` to skip relay
allocation entirely while testing on a network you already trust.

If TURN is not an option, a **phone hotspot is the reliable fallback**: both laptops
land on one subnet behind one NAT, so they connect on `host` candidates without
needing traversal at all.

## Architecture notes

- `apps/web/server.mjs` hosts Next.js and the Socket.IO signalling server together.
- `apps/web/hooks/useCamera.ts` owns local camera lifecycle.
- `apps/web/hooks/useWebRTC.ts` owns the peer connection and remote stream.
- `apps/web/lib/scoring.ts` is still the replaceable client-side placeholder.
- **Route reporting:** `readActiveRoute()` in [`apps/web/lib/iceStats.ts`](apps/web/lib/iceStats.ts)
  polls `getStats()` for the succeeded candidate pair, the only reliable way to tell a
  direct connection from a relayed one. An exhausted ICE negotiation surfaces as
  `failed` rather than being folded into `disconnected`.
- `services/inference/src/fitted_inference/engine.py` is the model-loading and paired
  inference boundary. Models should load once during FastAPI startup.
- Training datasets, model weights, checkpoints, and experiment output are ignored;
  store them outside Git or in a dedicated artifact store.

See [docs/PRD.md](docs/PRD.md) for product scope and
[services/inference/README.md](services/inference/README.md) for the API contract.
