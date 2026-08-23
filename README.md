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
npm run setup:model
Copy-Item services/inference/.env.example .env
```

`setup:model` downloads the pinned Fashionpedia RF-DETR-Seg checkpoint into the
ignored `models/rfdetr-fashionpedia/` directory. It prefers the project's GitHub
Release when `GITHUB_TOKEN` or `GH_TOKEN` can access the private repository and
otherwise uses the same pinned public Hugging Face revision.
It accepts the artifact only when both its 134,442,577-byte size and SHA-256
`aafefc440ea8f3f388e894a898e4270a2eeb6e38a3c3ffd3751d07d0f30b26bb`
match. Re-running the command is safe and skips an already verified checkpoint.

The live fit ranker needs no such download. Its 29 KB artifact
(`models/ranker/ranker.npz` and `ranker.json`) is committed, because its
training inputs — the label pool and the 7.8 GB Fashion144k teacher pool — are
not, and so a clone could not rebuild it. Live scoring does need the `ml`
extra for the frozen DINOv2-S encoder.

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
- `apps/web/lib/iceStats.ts` reports gathered candidates and polls the successful
  candidate pair to distinguish direct, NAT-traversed, and relayed routes.
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

## AI usage

Parts of this project were built with AI assistance, and parts of the product
itself are AI models. This section records what, where, and how it was checked.

### Assistance during development

- **Claude Code** (Anthropic, Claude Opus 5) — used interactively for
  implementation, refactoring, debugging and documentation.
- **Claude Design** — used to generate the visual direction. Two design canvases
  were produced from written briefs and then implemented by hand into the app's
  stylesheet; the canvases themselves are not part of the repository.

19 of the 109 commits on `main` carry a `Co-Authored-By: Claude` trailer, so the
exact scope is auditable with:

```bash
git log --grep='Co-Authored-By: Claude' --oneline
```

Those commits are concentrated in:

- the pairwise outfit labelling station (`/label`), its pair construction and
  split logic, per-rater storage, aggregation, and the ingest and merge scripts;
- the street/arcade visual system in `apps/web/app/globals.css`, and its port
  onto the monorepo layout;
- the battle countdown and result overlays, and the server-side round lead-in;
- the developer UI preview harness (`/preview`) and the `BattleStage` split that
  made it possible;
- `docs/PRD.md` delivery-status accuracy, and `docs/labelling-station.md` and
  `docs/ui-preview.md`.

The machine-learning work is the team's own: training the fit ranker, the
DINOv2/PCA/linear pipeline and its evaluation, the RF-DETR garment perception
adapter, the Gemini scoring integration, the MediaPipe pose-detection worker and
CV gating, WebRTC and TURN networking, and the leaderboard. The last of those
name models the product calls; the integration code around them was hand-written.

### Models the product runs

FITTED is not an AI-assisted build of a conventional app — inference is the
product. Four third-party models are involved:

| Model | Role in the product |
|---|---|
| **Gemini 3.6 Flash** (Google) | Final-round scoring assessor, `services/inference/src/fitted_inference/vlm.py`, enabled by `GEMINI_API_KEY` with `FITTED_SCORING_BACKEND=vlm_fallback` |
| **DINOv2-S** (`facebook/dinov2-small`, Meta) | Frozen image encoder behind the trained fit ranker |
| **RF-DETR-Seg Small**, Fashionpedia-trained (`resoa/garment-detector-seg`) | Garment detection and segmentation lane, pinned by `npm run setup:model` |
| **MediaPipe Pose Landmarker Lite** (Google) | Client-side pose gating in the browser worker |

The RF-DETR checkpoint's model card declares its weights Apache 2.0; Fashionpedia
attribution applies to it. Checkpoints are pinned rather than vendored, and are
not committed to this repository.

### Where the training labels came from

The label pool has two parts, and only one of them is human.

- **Human — 1,263 A/B decisions** in `data/labelling/decisions.*.jsonl`
  (AC 486, DP 600, FW 177; 1,252 usable), made by the three team members at the
  `/label` station. No model produced any of these.
- **Teacher — 1,972 pairs** in `data/labelling/teacher.jsonl`, generated by
  **Gemini 3.6 Flash**. Every record carries `"model": "gemini-3.6-flash"`.

The shipped ranker artifact (`models/ranker/ranker.json`) is trained on both:
761 human training pairs plus all 1,972 teacher pairs. Distillation does most of
the work — with no human label at all the student reaches 0.709 on the AC+DP
validation split, against 0.715 for human labels only. Treat the ranker as
partly distilled from Gemini, not as a purely human-supervised model. The full
comparison is in [docs/PRD.md](docs/PRD.md).

Teacher images are sampled from **Fashion144k**, whose terms restrict use to
non-commercial research and education; a hackathon prototype qualifies, a
commercial FITTED would not. The dataset's own fashionability scores are
deliberately discarded — only the pixels are used.

> Edgar Simo-Serra, Sanja Fidler, Francesc Moreno-Noguer and Raquel Urtasun.
> "Neuroaesthetics in Fashion: Modeling the Perception of Fashionability."
> CVPR 2015.

### How it was checked

AI-authored changes were reviewed before commit and verified against
`npm run typecheck` and `npm run test` — which covers the web, signalling,
scoring-coordinator and API suites — with UI changes confirmed by rendering the
pages rather than by inspection alone. Several defects were found that way and
are recorded in the commit history: for example `b90d283`, where a missing
`min-height: 0` only surfaced once a real video stream was attached.

The model-generated labels were not taken on trust either. Gemini was scored
against the project's own raters on the same held-out pairs as the human ceiling
and the trained student (`services/inference/scripts/benchmark_judges.py`), and
teacher-trained and human-trained configurations are reported separately rather
than pooled into one headline number.

This section covers commits identifiable by the co-author trailer. Team members
who used other tools should extend it rather than assume it speaks for them.

See [docs/PRD.md](docs/PRD.md) for product scope and
[services/inference/README.md](services/inference/README.md) for the API contract.
