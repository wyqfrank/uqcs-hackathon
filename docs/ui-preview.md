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

## Limits

- Controls are inert. The dock buttons render in the right state but do
  nothing — this previews appearance, not behaviour.
- No real inference. Scores and explanations are fixed strings.
- Timing is not simulated. The countdown shows a static number rather than
  ticking, so it will not tell you whether three seconds *feels* right.
