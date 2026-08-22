# UI preview

A development-only route that renders the battle screen from mock state — no
camera, no peer connection, no second player, no signalling server.

```bash
npm run dev:web        # or npm run dev
```

Then open <http://localhost:3000/preview>.

Pick a scenario from the switcher across the top. The screen below is the real
`BattleStage` component the room uses, so what you see is what a player sees.

## Why it exists

Most of these states are awkward or near-impossible to reach deliberately:

| Scenario | Reaching it for real |
|---|---|
| Waiting · neither ready | easy |
| Waiting · you ready | coordinate timing with a second person |
| Countdown | catch a 3-second window |
| Collecting frames | a fraction of a second |
| Analysing | a couple of seconds |
| Final · you win / you lose | play a full battle |
| **Final · draw** | needs two near-identical outfits |
| Not scoreable | deliberately ruin a frame |
| Camera denied | revoke browser permission |
| Waiting for opponent | leave the room half-joined |
| Connection lost | pull the network mid-round |

The harness found a real bug the first time it ran: `.player-card` carried the
grid-item default `min-height: auto`, so with a live stream attached the
`<video>` contributed its intrinsic 1080px height and blew the panel past the
fold. Static screenshots never caught it because placeholders have no intrinsic
size.

## How it is wired

- `app/preview/page.tsx` — calls `notFound()` when `NODE_ENV` is production.
- `app/preview/scenarios.ts` — the mock states. **Add scenarios here.**
- `app/preview/PreviewStage.tsx` — feeds mock props into `BattleStage`, and
  fakes the webcams with a canvas-backed `MediaStream` so the panels contain a
  genuine `<video>` at the real aspect ratio.
- `app/preview/LiveModelReadout.tsx` — the diagnostic panel shown in live model
  mode.

`BattleRoom` is split in two so the preview never drifts from production:

```
BattleRoom   — wires the hooks (camera, WebRTC, scoring, perception)
BattleStage  — pure function of props: everything the screen draws
```

The preview renders `BattleStage` directly. Any change to the battle UI shows
up here automatically; there is no second copy to keep in sync.

## Adding a scenario

Append to `SCENARIOS` in `app/preview/scenarios.ts`:

```ts
{
  id: "camera-unavailable",
  label: "No camera found",
  state: { phase: "waiting_ready", playerAReady: false, playerBReady: false },
  cameraStatus: "unavailable",
  hasLocalStream: false,
  cameraError: "No camera was found. Plug one in and try again.",
}
```

Only `id`, `label` and `state` are required. Everything else overrides an
otherwise healthy connected battle: `connectionState`, `connectionError`,
`cameraStatus`, `cameraError`, `hasLocalStream`, `hasRemoteStream`, `scores`,
`provisional`.

## Playing a whole round

**▶ PLAY ROUND** (right-hand end of the switcher) walks the real sequence on
real timers, using the server's default durations:

```
0.0s  framing            one player ready, then both
1.4s  lead-in            overlay counts 3 -> 2 -> 1        (FITTED_ROUND_LEAD_IN_MS)
4.4s  scoring            no overlay; live estimates drift  (FITTED_ROUND_DURATION_MS)
9.4s  capturing fits
10.3s analysing
12.1s result             overlay with the verdict
```

The static scenarios show what each phase *looks* like; this shows how the
round *feels*. Whether three seconds is long enough to settle into frame, and
whether the cut from scoring to analysing lands or jars, are questions a still
frame cannot answer.

Durations live in `useSimulatedRound.ts` as `LEAD_IN_MS` and `ROUND_MS`. Change
them there to try a different pacing before changing the server.

## Live model mode

**◉ LIVE MODEL** turns on the real camera and the real ranker. Scores on screen
come from the trained model reading your webcam, not from a random walk.

It needs the inference service running with an artifact present:

```bash
npm run dev            # both, or:
npm run dev:api        # service only, port 8000
```

If `models/ranker/ranker.npz` is missing — it is gitignored, so it is missing
after a fresh clone — the readout says so and explains how to regenerate it.
Nothing else in the harness is affected.

### What it is for

The model was trained on curated full-body photos, and its PCA basis was fitted
on 128 of them. Live input is a 640px webcam crop under whatever lighting the
room has. Nothing about the offline numbers says how it behaves on that, and
the failure mode is silent: an embedding that lands off the fitted manifold
still produces a confident score.

The readout in the bottom-right corner is the instrument for that. Two checks:

| Check | How | What good looks like |
|---|---|---|
| **Stability** | Stand still in one outfit for ~20 samples | Raw spread stays tight; the sparkline is flat-ish |
| **Separation** | Change into a visibly different outfit | The two raw ranges do not overlap |

Both read **raw margins**, not the smoothed display score. Smoothing is there
so the number on the card does not jitter, and it would hide exactly the
instability being tested.

If stability fails, the live score is reading noise rather than the outfit, and
wiring it into a real battle would replace an honest placeholder with a
dishonest one.

### What the numbers mean

- **SHOWN** — the smoothed display score, in the band the product uses.
- **RAW MARGIN** — the head's own output. It has no absolute scale; the model
  is only ever trained on the *sign* of a difference between two outfits.
- **PERCENTILE** — where that margin falls among the training images. This is
  the honest quantity, and the display score is just this mapped into a band.

A percentile means the score is a *rank against the training pool*, not a
verdict on the outfit in absolute terms.

## Limits

- Controls are inert. The dock buttons render in the right state but do
  nothing — this previews appearance, not behaviour.
- Scores and explanations in the static scenarios are fixed strings, and the
  live estimates during a simulated round are a random walk. Only **◉ LIVE
  MODEL** runs a model; finalisation is still never called.
- No second player, so nothing exercises the signalling or the peer
  connection. Live model mode scores your camera only; the opponent panel stays
  a placeholder.

### Live model mode is not a preview of the battle's live score

Both run the same trained model on the same person crop, but they reach it
differently, and only the room's path ships:

| | Preview ◉ LIVE MODEL | Real battle room |
|---|---|---|
| Trigger | client 1 FPS timer | server-owned frame request |
| Endpoint | `/v1/fit-score` | `/v1/fit-score/pair` |
| Players | local only | both, paired on one clock |
| Smoothing | EMA | none |
| Delivery | HTTP response | `fit-score` socket event |

The split is deliberate — the diagnostic needs one camera, raw margins and no
pairing — but it means the preview cannot show paired sampling, the
identity-mismatch drop, the 503 backoff, or how the number reads unsmoothed.

`BattleStage` is still a pure function of props, so the *visuals* cannot drift.
What feeds the score prop now has two implementations.

Note also that **▶ PLAY ROUND's drifting live estimate is now fiction**: it is a
random walk, and production no longer has any seeded fallback, so a real battle
with no model shows an empty bar instead.
