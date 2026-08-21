# MOG — Product Requirements Document

## 1. Overview

**Working name:** MOG  
**Status:** Hackathon prototype  
**Document status:** Draft — unresolved decisions are marked **TBD**

MOG is a live fashion battle where two people connect through their cameras and an ML system compares their outfits.

The prototype should answer one central question: can an ML model act as a fun, fast referee for a live outfit comparison?

---

## 2. Product Goal

Create a reliable two-player experience in which:

1. one player creates a battle;
2. a second player joins from another device;
3. both players can see each other's live camera feed;
4. the system analyses both outfits; and
5. the UI presents a comparison quickly enough to feel interactive.

The exact meaning and presentation of the comparison are still **TBD**.

---

## 3. Target Experience

```text
Player A creates a battle
          ↓
Player B joins with the room code
          ↓
Both players grant camera access
          ↓
Both live feeds connect
          ↓
The ML system analyses both outfits
          ↓
A comparison result is shown
```

### Experience principles

- Fast to start.
- Clearly communicate camera, connection, opponent, and analysis states.
- Keep the video experience smooth while analysis runs separately.
- Make the result easy to understand at a glance.
- Treat the comparison as entertainment, not an objective judgement of a person.

---

## 4. MVP Requirements

### Required

- Create a two-player battle room.
- Join a battle using a room code.
- Connect two separate laptops or devices.
- Request and display each player's webcam feed.
- Show both live feeds in the battle room.
- Capture frames for ML inference without interrupting video playback.
- Pass outfit imagery through an ML inference boundary.
- Receive an outfit comparison result.
- Display the result and relevant loading, error, and connection states.
- Support leaving a battle and handling a disconnected opponent.

### Nice to have

**TBD — prioritise after the core two-player flow and ML approach have been validated.**

Questions to resolve before adding items here:

- Which additions make the battle meaningfully more fun or repeatable?
- Which additions improve demo reliability or make the ML result clearer?
- What can be completed without risking the required flow?

---

## 5. User Interface

The current prototype is the baseline and is expected to be close to the final hackathon UI. Visual polish may continue, but a major redesign is not currently planned.

### Landing screen

- MOG branding and short explanation of the battle.
- **Create Battle** action.
- **Join Battle** action.
- Room-code entry and validation.

### Battle room

- Symmetrical local and opponent video panels.
- Player labels and room code.
- Camera and peer-connection status.
- Waiting, connecting, analysing, disconnected, and error states.
- Live comparison result or score area.
- Controls for camera, copying the room code, freezing/resuming the current score, and leaving.

### Result experience

The current score and winner treatment may be used as the prototype presentation, but the final result behaviour depends on unresolved product and ML decisions.

**TBD:**

- continuous score, final result, or both;
- absolute MOG scores versus a head-to-head winner;
- how and when a battle ends;
- how much reasoning or confidence to show;
- how to communicate poor framing or an outfit that is not sufficiently visible.

---

## 6. ML System

### Goal

Given images of two outfits, return a useful signal that allows the outfits to be compared.

### Tentative pipeline

```text
camera frames
      ↓
image selection and preprocessing
      ↓
vision representation
      ↓
ranking or scoring model
      ↓
comparison result
      ↓
UI
```

The live video frame rate must remain independent from the inference rate. The system should sample frames periodically, avoid building a backlog of stale frames, and display the latest valid result.

### ML decisions still required

- What does the model optimise for, and what is the proxy for “good taste”?
- What dataset or evaluation set will be used?
- Is the task pairwise ranking, absolute scoring, or another formulation?
- Which vision backbone or multimodal model should be used?
- Is training or fine-tuning required, or is a pretrained approach sufficient?
- How will scores be calibrated and stabilised over time?
- How frequently should inference run?
- How will the system reduce the influence of face, body, pose, lighting, and background?
- How will poor framing or incomplete outfit visibility be detected?
- How will model quality, bias, latency, and reliability be evaluated?

---

## 7. System Design

The prototype currently uses WebRTC for peer-to-peer video and Socket.IO for room signalling. Frame capture and a replaceable inference boundary also exist in the client.

These implementation choices are useful for the current demo but do not settle the complete system design.

### System design to determine

**TBD:**

- where ML inference runs: browser, shared server, separate ML service, or a hybrid;
- whether each client submits its own frames or one client coordinates the comparison;
- how frames reach inference: HTTP, WebSocket, WebRTC data channel, or another mechanism;
- how two players' samples are paired into a fair comparison;
- where room and battle state are owned;
- whether a separate backend service is needed and, if so, its language and framework;
- result delivery and synchronisation between both players;
- retry, timeout, reconnection, and failure behaviour;
- privacy rules for captured frames, including whether any images are retained;
- deployment and hosting approach for the demo;
- whether STUN alone is sufficient or TURN is required for the intended environment;
- observability needed to diagnose failures during the demo.

### Architecture placeholder

Replace this section with the selected design once the decisions above have been made.

```text
Laptop A ◄──── live video / signalling ────► Laptop B
    │                                           │
    └──────────── comparison system ────────────┘
                          │
                          ▼
                    result to both players
```

---

## 8. Success Criteria

The hackathon demo is successful when:

- two laptops can create and join the same battle;
- both camera feeds appear and remain usable;
- outfit frames can be analysed;
- the system returns a comparison;
- both users can understand the result;
- the interaction feels responsive; and
- the full flow can be demonstrated reliably.

**TBD:** specific targets for latency, model quality, result stability, connection success rate, and supported browsers/devices.

---

## 9. Out of Scope for the Initial Prototype

- Persistent profiles or battle history.
- Social feeds.
- Matchmaking.
- Global leaderboards.
- Ecommerce or outfit purchasing.
- Virtual try-on.
- Production-scale infrastructure.

This list may be revisited after the MVP and nice-to-have scope are agreed.

---

## 10. Open Product Questions

- Is the primary output a score, a winner, or both?
- Is scoring continuous, frozen by a player, or finalised automatically?
- What makes a battle fun enough to repeat?
- What explanation should accompany a result?
- What language should the product use to avoid presenting subjective taste as objective fact?
- What happens when the model cannot make a reliable comparison?

---

## 11. Decisions Log

Only record choices here once the team has agreed to them.

| Area | Decision | Status | Notes |
| --- | --- | --- | --- |
| Product format | Two-player live camera battle | Decided | Core prototype concept |
| Frontend | Next.js, React, TypeScript, Tailwind CSS, shadcn/ui | Decided | Current implementation |
| UI direction | Continue from the current prototype | Decided for hackathon | Polish is allowed; no major redesign planned |
| Live video | WebRTC | Current prototype choice | Reassess only if it blocks a reliable demo |
| Signalling | Socket.IO | Current prototype choice | Used for rooms and WebRTC negotiation |
| Result format | TBD | Open | Absolute score, head-to-head result, or both |
| ML approach | TBD | Open | See ML decisions |
| Inference location | TBD | Open | Browser, server, dedicated service, or hybrid |
| Frame transport | TBD | Open | Depends on inference architecture |
| Nice-to-have scope | TBD | Open | Decide after core-flow validation |
