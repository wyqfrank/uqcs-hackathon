import assert from "node:assert/strict";
import test from "node:test";
import { ScoringCoordinator, describeMissingFrames } from "../lib/scoring-coordinator.mjs";

class FakeIo {
  events = [];
  to(roomId) {
    return { emit: (name, payload) => this.events.push({ roomId, name, payload }) };
  }
}

class FakeSocket {
  constructor(id) {
    this.id = id;
    this.handlers = new Map();
    this.events = [];
  }
  on(name, handler) { this.handlers.set(name, handler); }
  emit(name, payload) { this.events.push({ name, payload }); }
}

const delay = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(fetchImpl, options = {}) {
  const io = new FakeIo();
  const diagnostics = [];
  const logger = {
    info: (...values) => diagnostics.push({ level: "info", values }),
    warn: (...values) => diagnostics.push({ level: "warn", values }),
    error: (...values) => diagnostics.push({ level: "error", values }),
  };
  let id = 0;
  const coordinator = new ScoringCoordinator({
    io,
    inferenceUrl: "http://inference.test",
    logger,
    fetchImpl,
    createId: () => `id-${++id}`,
    roundDurationMs: options.roundDurationMs ?? 1000,
    // Most tests are about the scored window, not the lead-in.
    roundLeadInMs: options.roundLeadInMs ?? 0,
    collectionTimeoutMs: options.collectionTimeoutMs ?? 80,
    burstOffsetsMs: options.burstOffsetsMs ?? [0],
    burstSlotTimeoutMs: options.burstSlotTimeoutMs ?? 40,
    inferenceTimeoutMs: options.inferenceTimeoutMs ?? 100,
    maxBurstBytes: options.maxBurstBytes ?? 1024,
  });
  const host = new FakeSocket("host-socket");
  const guest = new FakeSocket("guest-socket");
  coordinator.attachSocket(host);
  coordinator.attachSocket(guest);
  coordinator.assignPlayer(host, "FIT-1234", "host");
  coordinator.assignPlayer(guest, "FIT-1234", "guest");
  return { coordinator, diagnostics, io, host, guest };
}

function ready(coordinator, socket, value = true) {
  let acknowledgement;
  coordinator.reportReadiness(socket, { ready: value }, (result) => {
    acknowledgement = result;
  });
  return acknowledgement;
}

function startRound(coordinator, host, guest) {
  ready(coordinator, host);
  ready(coordinator, guest);
  return coordinator.rooms.get("FIT-1234");
}

async function startFinalisation(coordinator, host, guest, starter = host) {
  startRound(coordinator, host, guest);
  let acknowledgement;
  coordinator.requestFinalisation(starter, (result) => {
    acknowledgement = result;
  });
  await delay(2);
  return { acknowledgement, state: coordinator.rooms.get("FIT-1234") };
}

function finalFrame(state, slot, role, sampleId, byte = 1) {
  const offset = slot.burstIndex * 750;
  return {
    finalisationId: state.finalisationId,
    requestId: slot.requestId,
    burstIndex: slot.burstIndex,
    sampleId,
    capturedAtEpochMs: 1000 + offset + (role === "guest" ? 5 : 0),
    mimeType: "image/webp",
    image: Buffer.from([byte, byte + 1]),
  };
}

function garmentFrame(requestId, sampleId, byte = 1) {
  return {
    requestId,
    sampleId,
    capturedAtEpochMs: 1000,
    mimeType: "image/webp",
    cropBox: { x: 0.1, y: 0.05, width: 0.8, height: 0.9 },
    image: Buffer.from([byte, byte + 1]),
  };
}

function resultFromForm(form, overrides = {}) {
  const indexes = form.getAll("burst_index").map(Number);
  const playerAIds = form.getAll("player_a_sample_id");
  const playerBIds = form.getAll("player_b_sample_id");
  const playerATimes = form.getAll("player_a_captured_at_ms").map(Number);
  const playerBTimes = form.getAll("player_b_captured_at_ms").map(Number);
  const latest = indexes.length - 1;
  return {
    phase: "final",
    battleId: form.get("battle_id"),
    finalisationId: form.get("finalisation_id"),
    pairId: form.get("pair_id"),
    playerASampleId: playerAIds[latest],
    playerBSampleId: playerBIds[latest],
    playerACapturedAtMs: playerATimes[latest],
    playerBCapturedAtMs: playerBTimes[latest],
    samplePairs: indexes.map((burstIndex, index) => ({
      burstIndex,
      playerASampleId: playerAIds[index],
      playerBSampleId: playerBIds[index],
      playerACapturedAtMs: playerATimes[index],
      playerBCapturedAtMs: playerBTimes[index],
    })),
    playerAScore: 82,
    playerBScore: 71,
    winner: "player_a",
    ...overrides,
  };
}

test("pairs live garment frames by server role", async () => {
  const requests = [];
  const { coordinator, io, host, guest } = setup(async (_url, options) => {
    requests.push(options.body);
    return {
      ok: true,
      json: async () => ({
        battleId: "FIT-1234",
        pairId: options.body.get("pair_id"),
        playerASampleId: "host-garment",
        playerBSampleId: "guest-garment",
        playerA: { categories: [] },
        playerB: { categories: [] },
      }),
    };
  });
  const state = coordinator.perceptionRooms.get("FIT-1234");
  coordinator.requestGarmentFrames("FIT-1234", state);
  coordinator.submitGarmentFrame(
    guest,
    garmentFrame(state.requestId, "guest-garment", 7),
    () => {},
  );
  coordinator.submitGarmentFrame(
    host,
    garmentFrame(state.requestId, "host-garment", 3),
    () => {},
  );
  await flush();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].get("player_a_sample_id"), "host-garment");
  assert.equal(requests[0].get("player_b_sample_id"), "guest-garment");
  assert.equal(io.events.at(-1).name, "garment-result");
  assert.deepEqual(io.events.at(-1).payload.playerACropBox, {
    x: 0.1,
    y: 0.05,
    width: 0.8,
    height: 0.9,
  });
  assert.deepEqual(io.events.at(-1).payload.playerBCropBox, {
    x: 0.1,
    y: 0.05,
    width: 0.8,
    height: 0.9,
  });
});

test("rejects garment frames without valid source crop geometry", () => {
  const { coordinator, host } = setup(async () => {
    throw new Error("inference must not run");
  });
  const state = coordinator.perceptionRooms.get("FIT-1234");
  coordinator.requestGarmentFrames("FIT-1234", state);
  let acknowledgement;
  coordinator.submitGarmentFrame(
    host,
    { ...garmentFrame(state.requestId, "host"), cropBox: { x: 0.8, y: 0, width: 0.3, height: 1 } },
    (result) => { acknowledgement = result; },
  );

  assert.deepEqual(acknowledgement, {
    ok: false,
    error: "Garment frame metadata is invalid.",
  });
});

test("live garment inference has zero queue depth while a pair is in flight", async () => {
  let finishRequest;
  const pending = new Promise((resolve) => { finishRequest = resolve; });
  const { coordinator, io, host, guest } = setup(async () => pending);
  const state = coordinator.perceptionRooms.get("FIT-1234");
  coordinator.requestGarmentFrames("FIT-1234", state);
  coordinator.submitGarmentFrame(host, garmentFrame(state.requestId, "host"), () => {});
  coordinator.submitGarmentFrame(guest, garmentFrame(state.requestId, "guest"), () => {});
  coordinator.requestGarmentFrames("FIT-1234", state);

  assert.equal(state.inFlight, true);
  assert.equal(io.events.filter(({ name }) => name === "garment-frame-request").length, 1);
  finishRequest({ ok: false, status: 503, json: async () => ({ detail: "disabled" }) });
  await flush();
});

test("a configured lead-in holds scoring open until it elapses", async () => {
  const { coordinator, io, host, guest } = setup(async () => {
    throw new Error("inference must not run");
  }, { roundLeadInMs: 20, roundDurationMs: 1000 });

  ready(coordinator, host);
  ready(coordinator, guest);

  const state = coordinator.rooms.get("FIT-1234");
  assert.equal(state.phase, "starting");
  assert.equal(state.endsAt, null, "the scored window has no deadline yet");
  assert.equal(io.events.filter(({ name }) => name === "score-round-starting").length, 1);
  assert.equal(io.events.filter(({ name }) => name === "score-round-started").length, 0);

  const starting = io.events.find(({ name }) => name === "score-round-starting");
  assert.equal(typeof starting.payload.startsAt, "number");
  assert.equal(starting.payload.roundId, state.roundId);

  await new Promise((resolve) => setTimeout(resolve, 45));

  assert.equal(state.phase, "countdown");
  assert.equal(typeof state.endsAt, "number", "the scored window opens with a deadline");
  assert.equal(io.events.filter(({ name }) => name === "score-round-started").length, 1);
  // The round id survives the transition, so provisional scores stay keyed to it.
  assert.equal(io.events.find(({ name }) => name === "score-round-started").payload.roundId, state.roundId);
});

test("a player reconnecting during the lead-in is told about it", () => {
  const { coordinator, host, guest } = setup(async () => {
    throw new Error("inference must not run");
  }, { roundLeadInMs: 50 });

  ready(coordinator, host);
  ready(coordinator, guest);
  assert.equal(coordinator.rooms.get("FIT-1234").phase, "starting");

  const rejoiner = new FakeSocket("rejoin-socket");
  coordinator.attachSocket(rejoiner);
  coordinator.assignPlayer(rejoiner, "FIT-1234", "guest");

  const told = rejoiner.events.filter(({ name }) => name === "score-round-starting");
  assert.equal(told.length, 1, "the rejoining client receives the lead-in, not silence");
});

test("role-derived readiness starts exactly one server countdown", () => {
  const { coordinator, io, host, guest } = setup(async () => {
    throw new Error("inference must not run");
  });

  assert.deepEqual(ready(coordinator, host), { ok: true });
  assert.equal(coordinator.rooms.has("FIT-1234"), false);
  assert.deepEqual(ready(coordinator, guest), { ok: true });
  const first = coordinator.rooms.get("FIT-1234");
  ready(coordinator, guest);

  assert.equal(first.phase, "countdown");
  assert.equal(coordinator.rooms.get("FIT-1234"), first);
  assert.equal(io.events.filter(({ name }) => name === "score-round-started").length, 1);
});

test("the server timer automatically enters final collection", async () => {
  const { coordinator, io, host, guest } = setup(async () => {
    throw new Error("inference must not run without frames");
  }, { roundDurationMs: 12, collectionTimeoutMs: 80 });
  startRound(coordinator, host, guest);

  await delay(20);

  const state = coordinator.rooms.get("FIT-1234");
  assert.equal(state.phase, "collecting");
  assert.equal(io.events.some(({ name }) => name === "score-finalisation-started"), true);
});

test("either player can finalise early and pause garment perception", async () => {
  const { coordinator, host, guest } = setup(async () => {
    throw new Error("inference must not run before frames arrive");
  });
  startRound(coordinator, host, guest);
  let acknowledgement;
  coordinator.requestFinalisation(guest, (result) => { acknowledgement = result; });
  await delay(2);

  assert.equal(acknowledgement.ok, true);
  assert.equal(coordinator.rooms.get("FIT-1234").phase, "collecting");
  assert.equal(coordinator.perceptionRooms.has("FIT-1234"), false);
});

test("disconnect cancels a round and reconnect readiness starts a new one", () => {
  const { coordinator, io, host, guest } = setup(async () => {
    throw new Error("inference must not run");
  });
  const first = startRound(coordinator, host, guest);
  coordinator.leave(guest.id);

  assert.equal(coordinator.rooms.has("FIT-1234"), false);
  assert.equal(io.events.at(-1).name, "score-round-cancelled");
  const replacement = new FakeSocket("replacement-guest");
  coordinator.attachSocket(replacement);
  coordinator.assignPlayer(replacement, "FIT-1234", "guest");
  ready(coordinator, replacement);
  const second = coordinator.rooms.get("FIT-1234");

  assert.equal(second.phase, "countdown");
  assert.notEqual(second.roundId, first.roundId);
  coordinator.beginFinalisation("FIT-1234", first);
  assert.equal(coordinator.rooms.get("FIT-1234"), second);
});

test("five requested slots produce one ordered inference request", async () => {
  const requests = [];
  const { coordinator, diagnostics, io, host, guest } = setup(async (_url, options) => {
    requests.push(options.body);
    return { ok: true, json: async () => resultFromForm(options.body) };
  }, { burstOffsetsMs: [0, 5, 10, 15, 20], burstSlotTimeoutMs: 100, collectionTimeoutMs: 150 });
  const { state } = await startFinalisation(coordinator, host, guest);
  await delay(25);

  assert.deepEqual(
    io.events.filter(({ name }) => name === "score-frame-request").map(({ payload }) => payload.burstIndex),
    [0, 1, 2, 3, 4],
  );
  for (const slot of state.slots) {
    coordinator.submitFrame(host, finalFrame(state, slot, "host", `host-${slot.burstIndex}`), () => {});
    coordinator.submitFrame(guest, finalFrame(state, slot, "guest", `guest-${slot.burstIndex}`), () => {});
  }
  coordinator.finishBurstCollection("FIT-1234", state);
  await flush();

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].getAll("burst_index"), ["0", "1", "2", "3", "4"]);
  assert.deepEqual(
    requests[0].getAll("player_a_sample_id"),
    ["host-0", "host-1", "host-2", "host-3", "host-4"],
  );
  assert.deepEqual(
    requests[0].getAll("player_b_sample_id"),
    ["guest-0", "guest-1", "guest-2", "guest-3", "guest-4"],
  );
  assert.equal(coordinator.rooms.get("FIT-1234").phase, "final");
  assert.equal(diagnostics.some(({ values }) => values[0] === "[scoring] VLM request started"), true);
  assert.equal(diagnostics.some(({ values }) => values[0] === "[scoring] VLM request completed"), true);
});

test("normalises JPEG aliases and forwards a matching filename", async () => {
  let submittedForm;
  const { coordinator, host, guest } = setup(async (_url, options) => {
    submittedForm = options.body;
    return { ok: true, json: async () => resultFromForm(options.body) };
  });
  const { state } = await startFinalisation(coordinator, host, guest);
  const [slot] = state.slots;
  const hostFrame = finalFrame(state, slot, "host", "host-jpeg");
  hostFrame.mimeType = "IMAGE/JPG; charset=binary";
  coordinator.submitFrame(host, hostFrame, () => {});
  coordinator.submitFrame(guest, finalFrame(state, slot, "guest", "guest-webp"), () => {});
  coordinator.finishBurstCollection("FIT-1234", state);
  await flush();

  const [playerA] = submittedForm.getAll("player_a");
  const [playerB] = submittedForm.getAll("player_b");
  assert.equal(playerA.type, "image/jpeg");
  assert.equal(playerA.name, "player-a-0.jpg");
  assert.equal(playerB.type, "image/webp");
  assert.equal(playerB.name, "player-b-0.webp");
});

test("the newest submission replaces an earlier frame in the same slot", async () => {
  let submittedForm;
  const { coordinator, host, guest } = setup(async (_url, options) => {
    submittedForm = options.body;
    return { ok: true, json: async () => resultFromForm(options.body) };
  });
  const { state } = await startFinalisation(coordinator, host, guest);
  const [slot] = state.slots;
  coordinator.submitFrame(host, finalFrame(state, slot, "host", "old-host"), () => {});
  coordinator.submitFrame(host, finalFrame(state, slot, "host", "new-host", 4), () => {});
  coordinator.submitFrame(guest, finalFrame(state, slot, "guest", "guest"), () => {});
  coordinator.finishBurstCollection("FIT-1234", state);
  await flush();

  assert.equal(submittedForm.get("player_a_sample_id"), "new-host");
});

test("incomplete slots are discarded while a complete pair remains usable", async () => {
  let submittedForm;
  const { coordinator, host, guest } = setup(async (_url, options) => {
    submittedForm = options.body;
    return { ok: true, json: async () => resultFromForm(options.body) };
  }, { burstOffsetsMs: [0, 5, 10], burstSlotTimeoutMs: 100, collectionTimeoutMs: 150 });
  const { state } = await startFinalisation(coordinator, host, guest);
  await delay(15);
  coordinator.submitFrame(host, finalFrame(state, state.slots[0], "host", "host-0"), () => {});
  coordinator.submitFrame(guest, finalFrame(state, state.slots[0], "guest", "guest-0"), () => {});
  coordinator.submitFrame(host, finalFrame(state, state.slots[2], "host", "unpaired-host"), () => {});
  coordinator.finishBurstCollection("FIT-1234", state);
  await flush();

  assert.deepEqual(submittedForm.getAll("burst_index"), ["0"]);
  assert.equal(submittedForm.getAll("player_a").length, 1);
});

test("no complete pair returns retryable not-scoreable without inference", async () => {
  let calls = 0;
  const { coordinator, io, host, guest } = setup(async () => {
    calls += 1;
    return { ok: true, json: async () => ({}) };
  });
  const { state } = await startFinalisation(coordinator, host, guest);
  for (const socket of [host, guest]) {
    coordinator.reportUnavailable(socket, {
      finalisationId: state.finalisationId,
      requestId: state.slots[0].requestId,
      burstIndex: 0,
    });
  }

  assert.equal(calls, 0);
  assert.equal(io.events.at(-1).name, "score-result");
  assert.equal(io.events.at(-1).payload.phase, "not_scoreable");
  assert.equal(io.events.at(-1).payload.samplePairs.length, 0);
});

test("collection deadline expires without invoking inference", async () => {
  let calls = 0;
  const { coordinator, io, host, guest } = setup(async () => {
    calls += 1;
    return { ok: true, json: async () => ({}) };
  }, { collectionTimeoutMs: 15, burstSlotTimeoutMs: 8 });
  await startFinalisation(coordinator, host, guest);
  await delay(25);

  assert.equal(calls, 0);
  assert.equal(io.events.at(-1).payload.reasonCode, "frame_unavailable");
});

test("aggregate burst limit rejects excess image data", async () => {
  const { coordinator, host, guest } = setup(async () => {
    throw new Error("inference must not run");
  }, { maxBurstBytes: 3 });
  const { state } = await startFinalisation(coordinator, host, guest);
  const [slot] = state.slots;
  let acknowledgement;
  coordinator.submitFrame(host, finalFrame(state, slot, "host", "host"), () => {});
  coordinator.submitFrame(guest, finalFrame(state, slot, "guest", "guest"), (result) => {
    acknowledgement = result;
  });

  assert.equal(acknowledgement.ok, false);
  assert.match(acknowledgement.error, /too large/i);
});

test("extra frames are rejected while inference is active", async () => {
  let resolveRequest;
  let submittedForm;
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  const { coordinator, host, guest } = setup(async (_url, options) => {
    submittedForm = options.body;
    return pending;
  });
  const { state } = await startFinalisation(coordinator, host, guest);
  const [slot] = state.slots;
  coordinator.submitFrame(host, finalFrame(state, slot, "host", "host"), () => {});
  coordinator.submitFrame(guest, finalFrame(state, slot, "guest", "guest"), () => {});
  coordinator.finishBurstCollection("FIT-1234", state);
  let acknowledgement;
  coordinator.submitFrame(host, finalFrame(state, slot, "host", "late"), (result) => {
    acknowledgement = result;
  });

  assert.equal(acknowledgement.ok, false);
  resolveRequest({ ok: true, json: async () => resultFromForm(submittedForm) });
  await flush();
});

test("provider failure retains complete burst identity for retry", async () => {
  const { coordinator, io, host, guest } = setup(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ detail: "Gemini is unavailable." }),
  }));
  const { state } = await startFinalisation(coordinator, host, guest);
  const [slot] = state.slots;
  coordinator.submitFrame(host, finalFrame(state, slot, "host", "host-sample"), () => {});
  coordinator.submitFrame(guest, finalFrame(state, slot, "guest", "guest-sample"), () => {});
  coordinator.finishBurstCollection("FIT-1234", state);
  await flush();

  const result = io.events.at(-1).payload;
  assert.equal(result.reasonCode, "provider_unavailable");
  assert.equal(result.playerASampleId, "host-sample");
  assert.equal(result.samplePairs[0].playerBSampleId, "guest-sample");
});

test("a late response cannot overwrite a retry finalisation", async () => {
  let resolveRequest;
  let submittedForm;
  const { coordinator, io, host, guest } = setup(async (_url, options) => {
    submittedForm = options.body;
    return new Promise((resolve) => { resolveRequest = resolve; });
  });
  const { state } = await startFinalisation(coordinator, host, guest);
  const [slot] = state.slots;
  coordinator.submitFrame(host, finalFrame(state, slot, "host", "host"), () => {});
  coordinator.submitFrame(guest, finalFrame(state, slot, "guest", "guest"), () => {});
  coordinator.finishBurstCollection("FIT-1234", state);
  coordinator.failRoom("FIT-1234", state, "provider_timeout", "Retry.");
  let acknowledgement;
  coordinator.requestFinalisation(guest, (result) => { acknowledgement = result; });
  const replacement = coordinator.rooms.get("FIT-1234");
  resolveRequest({ ok: true, json: async () => resultFromForm(submittedForm) });
  await flush();

  assert.equal(acknowledgement.ok, true);
  assert.equal(coordinator.rooms.get("FIT-1234"), replacement);
  assert.equal(io.events.filter(({ name }) => name === "score-result").length, 1);
});

test("replays a locked result and readiness to a reconnecting player", () => {
  const { coordinator } = setup(async () => ({ ok: true, json: async () => ({}) }));
  const locked = { phase: "final", finalisationId: "final-1" };
  coordinator.rooms.set("FIT-1234", {
    phase: "final",
    finalisationId: "final-1",
    result: locked,
  });
  const replacement = new FakeSocket("replacement-host");
  coordinator.assignPlayer(replacement, "FIT-1234", "host");

  assert.equal(replacement.events[0].name, "score-result");
  assert.deepEqual(replacement.events[0].payload, locked);
  assert.equal(replacement.events[1].name, "score-readiness-updated");
});

test("disconnect clears pending work and an empty room clears readiness", async () => {
  const { coordinator, host, guest } = setup(async () => {
    throw new Error("inference must not run");
  });
  await startFinalisation(coordinator, host, guest);
  coordinator.leave(host.id);
  assert.equal(coordinator.rooms.has("FIT-1234"), false);
  coordinator.leave(guest.id);
  assert.equal(coordinator.readinessRooms.has("FIT-1234"), false);
});

test("records both players against the leaderboard when a battle finalises", async () => {
  const recorded = [];
  const io = new FakeIo();
  const coordinator = new ScoringCoordinator({
    io,
    inferenceUrl: "http://inference.test",
    leaderboard: { recordBattle: (players) => { recorded.push(players); return Promise.resolve([]); } },
  });
  const host = new FakeSocket("host-socket");
  const guest = new FakeSocket("guest-socket");
  coordinator.attachSocket(host);
  coordinator.attachSocket(guest);
  coordinator.assignPlayer(host, "FIT-1234", "host", "Angus");
  coordinator.assignPlayer(guest, "FIT-1234", "guest", "Frank");

  coordinator.recordStandings("FIT-1234", {
    playerAScore: 82.4,
    playerBScore: 77.1,
    winner: "player_a",
  });

  assert.deepEqual(recorded, [[
    { name: "Angus", score: 82.4, won: true },
    { name: "Frank", score: 77.1, won: false },
  ]]);
});

test("credits nobody a win on a draw", async () => {
  const recorded = [];
  const io = new FakeIo();
  const coordinator = new ScoringCoordinator({
    io,
    inferenceUrl: "http://inference.test",
    leaderboard: { recordBattle: (players) => { recorded.push(players); return Promise.resolve([]); } },
  });
  const host = new FakeSocket("host-socket");
  const guest = new FakeSocket("guest-socket");
  coordinator.attachSocket(host);
  coordinator.attachSocket(guest);
  coordinator.assignPlayer(host, "FIT-1234", "host", "Angus");
  coordinator.assignPlayer(guest, "FIT-1234", "guest", "Frank");

  coordinator.recordStandings("FIT-1234", {
    playerAScore: 70,
    playerBScore: 70,
    winner: "draw",
  });

  assert.deepEqual(recorded[0].map((player) => player.won), [false, false]);
});

test("skips unnamed players rather than recording a blank entry", async () => {
  const recorded = [];
  const io = new FakeIo();
  const coordinator = new ScoringCoordinator({
    io,
    inferenceUrl: "http://inference.test",
    leaderboard: { recordBattle: (players) => { recorded.push(players); return Promise.resolve([]); } },
  });
  const host = new FakeSocket("host-socket");
  const guest = new FakeSocket("guest-socket");
  coordinator.attachSocket(host);
  coordinator.attachSocket(guest);
  coordinator.assignPlayer(host, "FIT-1234", "host", "Angus");
  coordinator.assignPlayer(guest, "FIT-1234", "guest", "");

  coordinator.recordStandings("FIT-1234", {
    playerAScore: 60,
    playerBScore: 50,
    winner: "player_a",
  });

  assert.deepEqual(recorded, [[{ name: "Angus", score: 60, won: true }]]);
});

test("a leaderboard failure does not surface to the battle", async () => {
  const io = new FakeIo();
  const coordinator = new ScoringCoordinator({
    io,
    inferenceUrl: "http://inference.test",
    leaderboard: { recordBattle: () => Promise.reject(new Error("disk full")) },
  });
  const host = new FakeSocket("host-socket");
  coordinator.attachSocket(host);
  coordinator.assignPlayer(host, "FIT-1234", "host", "Angus");

  assert.doesNotThrow(() =>
    coordinator.recordStandings("FIT-1234", {
      playerAScore: 60,
      playerBScore: 50,
      winner: "player_a",
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
});

const slotsWith = (reasons, supplied = {}) => [0, 1, 2].map(() => ({
  reasons: { player_a: null, player_b: null, ...reasons },
  responses: {
    player_a: supplied.player_a ? "frame" : "unavailable",
    player_b: supplied.player_b ? "frame" : "unavailable",
  },
  frames: { player_a: null, player_b: null },
}));

test("names the player whose framing failed instead of blaming cameras", () => {
  const message = describeMissingFrames(
    slotsWith({ player_a: "partial_outfit" }, { player_b: { image: Buffer.from([1]) } }),
  );

  assert.match(message, /Player 1/);
  assert.match(message, /not enough of the outfit was in frame/);
  assert.doesNotMatch(message, /Player 2/);
});

test("reports both players when neither supplied a frame", () => {
  const message = describeMissingFrames(
    slotsWith({ player_a: "no_person", player_b: "low_light" }),
  );

  assert.match(message, /Player 1: nobody was detected in frame/);
  assert.match(message, /Player 2: the light was too low/);
});

test("falls back to a plain statement when the client gave no reason", () => {
  const message = describeMissingFrames(
    slotsWith({}, { player_a: { image: Buffer.from([1]) } }),
  );

  assert.match(message, /Player 2 sent no usable frame/);
});

test("does not accuse anyone when both sides did supply frames", () => {
  const message = describeMissingFrames(
    slotsWith({}, { player_a: { image: Buffer.from([1]) }, player_b: { image: Buffer.from([2]) } }),
  );

  assert.match(message, /could not be paired in time/);
});

test("does not blame a player whose frames were discarded with the pair", () => {
  // settleBurstSlot nulls both frames when a pair is incomplete, so attribution
  // has to come from responses or the supplier gets blamed too.
  const slots = [0, 1, 2].map(() => ({
    reasons: { player_a: "partial_outfit", player_b: null },
    responses: { player_a: "pending", player_b: "frame" },
    frames: { player_a: null, player_b: null },
  }));

  const message = describeMissingFrames(slots);
  assert.match(message, /Player 1/);
  assert.doesNotMatch(message, /Player 2/);
});

test("a frame in an unsupported format is recorded, not left pending", async () => {
  const { coordinator, host, guest } = setup(async () => ({ ok: true, json: async () => ({}) }));
  const { state } = await startFinalisation(coordinator, host, guest);
  const [slot] = state.slots;

  let ack = null;
  coordinator.submitFrame(
    host,
    { ...finalFrame(state, slot, "host", "host"), mimeType: "image/gif" },
    (value) => { ack = value; },
  );

  assert.equal(ack.ok, false);
  // The critical part: a rejected upload must not look like a silent client.
  assert.equal(slot.responses.player_a, "unavailable");
  assert.equal(slot.reasons.player_a, "unsupported_format");
});

test("Safari's PNG fallback is accepted rather than rejected", async () => {
  const { coordinator, host, guest } = setup(async () => ({ ok: true, json: async () => ({}) }));
  const { state } = await startFinalisation(coordinator, host, guest);
  const [slot] = state.slots;

  let ack = null;
  coordinator.submitFrame(
    host,
    { ...finalFrame(state, slot, "host", "host"), mimeType: "image/png" },
    (value) => { ack = value; },
  );

  assert.equal(ack.ok, true);
  assert.equal(slot.responses.player_a, "frame");
});

test("a rematch clears a settled battle and starts the next round", async () => {
  const { coordinator, io, host, guest } = setup(async () => ({ ok: true, json: async () => ({}) }));
  const { state } = await startFinalisation(coordinator, host, guest);
  state.phase = "final";
  state.result = { phase: "final" };

  let ack = null;
  coordinator.requestRematch(host, (value) => { ack = value; });

  assert.equal(ack.ok, true);
  assert.equal(io.events.some((event) => event.name === "score-rematch"), true);
  // Both players stayed ready, so the next round begins without re-arming.
  assert.equal(coordinator.rooms.get("FIT-1234")?.phase, "countdown");
});

test("a rematch is refused while a battle is still being scored", async () => {
  const { coordinator, host, guest } = setup(async () => ({ ok: true, json: async () => ({}) }));
  const { state } = await startFinalisation(coordinator, host, guest);
  state.phase = "collecting";

  let ack = null;
  coordinator.requestRematch(host, (value) => { ack = value; });

  assert.equal(ack.ok, false);
  assert.match(ack.error, /current score/);
  // The in-flight battle must survive a stray click from either player.
  assert.equal(coordinator.rooms.get("FIT-1234"), state);
});
