import assert from "node:assert/strict";
import test from "node:test";
import { ScoringCoordinator } from "../lib/scoring-coordinator.mjs";

class FakeIo {
  events = [];

  to(roomId) {
    return {
      emit: (name, payload) => this.events.push({ roomId, name, payload }),
    };
  }
}

class FakeSocket {
  constructor(id) {
    this.id = id;
    this.handlers = new Map();
    this.events = [];
  }

  on(name, handler) {
    this.handlers.set(name, handler);
  }

  emit(name, payload) {
    this.events.push({ name, payload });
  }
}

function setup(fetchImpl, options = {}) {
  const io = new FakeIo();
  const ids = ["final-1", "pair-1", "final-2", "pair-2"];
  const coordinator = new ScoringCoordinator({
    io,
    inferenceUrl: "http://inference.test",
    fetchImpl,
    createId: () => ids.shift(),
    collectionTimeoutMs: options.collectionTimeoutMs ?? 3000,
  });
  const host = new FakeSocket("host-socket");
  const guest = new FakeSocket("guest-socket");
  coordinator.attachSocket(host);
  coordinator.attachSocket(guest);
  coordinator.assignPlayer(host, "FIT-1234", "host");
  coordinator.assignPlayer(guest, "FIT-1234", "guest");
  return { coordinator, io, host, guest };
}

function frame(finalisationId, sampleId, byte = 1) {
  return {
    finalisationId,
    sampleId,
    capturedAtEpochMs: 1000,
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
    image: Buffer.from([byte, byte + 1]),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("pairs live garment frames by server role and broadcasts a separate result", async () => {
  const requests = [];
  const result = {
    battleId: "FIT-1234",
    pairId: "final-1",
    playerASampleId: "host-garment",
    playerBSampleId: "guest-garment",
    playerA: { categories: [] },
    playerB: { categories: [] },
  };
  const { coordinator, io, host, guest } = setup(async (url, options) => {
    requests.push({ url, form: options.body });
    return { ok: true, json: async () => result };
  });
  const state = coordinator.perceptionRooms.get("FIT-1234");

  coordinator.requestGarmentFrames("FIT-1234", state);
  coordinator.submitGarmentFrame(
    guest,
    garmentFrame("final-1", "guest-garment", 7),
    () => {},
  );
  coordinator.submitGarmentFrame(
    host,
    garmentFrame("final-1", "host-garment", 3),
    () => {},
  );
  await flush();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://inference.test/v1/garments/pair");
  assert.equal(requests[0].form.get("player_a_sample_id"), "host-garment");
  assert.equal(requests[0].form.get("player_b_sample_id"), "guest-garment");
  assert.deepEqual(io.events.at(-1), {
    roomId: "FIT-1234",
    name: "garment-result",
    payload: result,
  });
});

test("live garment inference has zero queue depth while a pair is in flight", async () => {
  let finishRequest;
  const pending = new Promise((resolve) => { finishRequest = resolve; });
  const { coordinator, io, host, guest } = setup(async () => pending);
  const state = coordinator.perceptionRooms.get("FIT-1234");

  coordinator.requestGarmentFrames("FIT-1234", state);
  coordinator.submitGarmentFrame(host, garmentFrame("final-1", "host"), () => {});
  coordinator.submitGarmentFrame(guest, garmentFrame("final-1", "guest"), () => {});
  coordinator.requestGarmentFrames("FIT-1234", state);

  assert.equal(state.inFlight, true);
  assert.equal(state.requestId, null);
  assert.equal(
    io.events.filter(({ name }) => name === "garment-frame-request").length,
    1,
  );
  finishRequest({ ok: false, json: async () => ({ detail: "not configured" }) });
  await flush();
});

test("finalisation aborts and pauses the live garment lane", () => {
  const { coordinator, host } = setup(async () => {
    throw new Error("no request expected");
  });
  const state = coordinator.perceptionRooms.get("FIT-1234");
  coordinator.requestGarmentFrames("FIT-1234", state);

  coordinator.requestFinalisation(host, () => {});
  let acknowledgement;
  coordinator.submitGarmentFrame(
    host,
    garmentFrame("final-1", "late-garment"),
    (value) => { acknowledgement = value; },
  );

  assert.equal(coordinator.perceptionRooms.has("FIT-1234"), false);
  assert.equal(acknowledgement.ok, false);
  assert.equal(acknowledgement.paused, true);
});

test("pairs server-derived roles once and broadcasts the authoritative result", async () => {
  const requests = [];
  const result = {
    phase: "final",
    battleId: "FIT-1234",
    finalisationId: "final-1",
    pairId: "pair-1",
    playerAScore: 82,
    playerBScore: 71,
    winner: "player_a",
  };
  const { coordinator, io, host, guest } = setup(async (_url, options) => {
    requests.push(options.body);
    return { ok: true, json: async () => result };
  });

  let finaliseAck;
  coordinator.requestFinalisation(host, (value) => { finaliseAck = value; });
  coordinator.submitFrame(guest, frame("final-1", "guest-sample", 7), () => {});
  coordinator.submitFrame(host, frame("final-1", "host-sample", 3), () => {});
  await flush();

  assert.deepEqual(finaliseAck, { ok: true, finalisationId: "final-1", locked: false });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].get("player_a_sample_id"), "host-sample");
  assert.equal(requests[0].get("player_b_sample_id"), "guest-sample");
  assert.deepEqual(io.events.at(-1), {
    roomId: "FIT-1234",
    name: "score-result",
    payload: result,
  });
  assert.equal(coordinator.rooms.get("FIT-1234").phase, "final");
});

test("either player can start finalisation", () => {
  const { coordinator, io, guest } = setup(async () => {
    throw new Error("inference must not run before frames arrive");
  });
  let acknowledgement;

  coordinator.requestFinalisation(guest, (value) => { acknowledgement = value; });

  assert.deepEqual(acknowledgement, {
    ok: true,
    finalisationId: "final-1",
    locked: false,
  });
  assert.equal(io.events.at(-1).name, "score-finalisation-started");
});

test("replaces a player's pending frame with its newest submission", async () => {
  let submittedForm;
  const result = {
    phase: "final",
    battleId: "FIT-1234",
    finalisationId: "final-1",
    pairId: "pair-1",
  };
  const { coordinator, host, guest } = setup(async (_url, options) => {
    submittedForm = options.body;
    return { ok: true, json: async () => result };
  });

  coordinator.requestFinalisation(host, () => {});
  coordinator.submitFrame(host, frame("final-1", "old-host"), () => {});
  coordinator.submitFrame(host, frame("final-1", "new-host"), () => {});
  coordinator.submitFrame(guest, frame("final-1", "guest"), () => {});
  await flush();

  assert.equal(submittedForm.get("player_a_sample_id"), "new-host");
});

test("rejects stale finalisation IDs without invoking inference", () => {
  let calls = 0;
  const { coordinator, host } = setup(async () => {
    calls += 1;
    return { ok: true, json: async () => ({}) };
  });
  coordinator.requestFinalisation(host, () => {});
  let acknowledgement;

  coordinator.submitFrame(host, frame("stale-final", "sample"), (value) => {
    acknowledgement = value;
  });

  assert.equal(acknowledgement.ok, false);
  assert.equal(calls, 0);
});

test("a missing local candidate produces a retryable not-scoreable result", () => {
  const { coordinator, io, host } = setup(async () => {
    throw new Error("inference must not run");
  });
  coordinator.requestFinalisation(host, () => {});

  coordinator.reportUnavailable(host, { finalisationId: "final-1" });

  const event = io.events.at(-1);
  assert.equal(event.name, "score-result");
  assert.equal(event.payload.phase, "not_scoreable");
  assert.equal(event.payload.reasonCode, "frame_unavailable");
  assert.equal(event.payload.retryable, true);
});

test("collection deadline expires without invoking inference", async () => {
  let calls = 0;
  const { coordinator, io, host } = setup(async () => {
    calls += 1;
    return { ok: true, json: async () => ({}) };
  }, { collectionTimeoutMs: 10 });
  coordinator.requestFinalisation(host, () => {});

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(calls, 0);
  assert.equal(io.events.at(-1).payload.reasonCode, "frame_unavailable");
  assert.equal(coordinator.rooms.get("FIT-1234").phase, "failed");
});

test("rejects extra frames while one inference request is active", async () => {
  let resolveRequest;
  let calls = 0;
  const { coordinator, host, guest } = setup(() => {
    calls += 1;
    return new Promise((resolve) => { resolveRequest = resolve; });
  });
  coordinator.requestFinalisation(host, () => {});
  coordinator.submitFrame(host, frame("final-1", "host"), () => {});
  coordinator.submitFrame(guest, frame("final-1", "guest"), () => {});
  let acknowledgement;

  coordinator.submitFrame(host, frame("final-1", "host-late"), (value) => {
    acknowledgement = value;
  });

  assert.equal(calls, 1);
  assert.equal(acknowledgement.ok, false);
  resolveRequest({
    ok: true,
    json: async () => ({
      phase: "final",
      battleId: "FIT-1234",
      finalisationId: "final-1",
      pairId: "pair-1",
    }),
  });
  await flush();
});

test("provider failure retains paired sample identity for retry UI", async () => {
  const { coordinator, io, host, guest } = setup(async () => ({
    ok: false,
    status: 503,
    json: async () => ({ detail: "Gemini is unavailable." }),
  }));
  coordinator.requestFinalisation(host, () => {});
  coordinator.submitFrame(host, frame("final-1", "host-sample"), () => {});
  coordinator.submitFrame(guest, frame("final-1", "guest-sample"), () => {});

  await flush();

  const result = io.events.at(-1).payload;
  assert.equal(result.phase, "not_scoreable");
  assert.equal(result.reasonCode, "provider_unavailable");
  assert.equal(result.playerASampleId, "host-sample");
  assert.equal(result.playerBSampleId, "guest-sample");
  assert.equal(result.playerACapturedAtMs, 1000);
});

test("a late inference response cannot overwrite a newer finalisation", async () => {
  let resolveRequest;
  const { coordinator, io, host, guest } = setup(() => new Promise((resolve) => {
    resolveRequest = resolve;
  }));
  coordinator.requestFinalisation(host, () => {});
  coordinator.submitFrame(host, frame("final-1", "host"), () => {});
  coordinator.submitFrame(guest, frame("final-1", "guest"), () => {});
  const firstState = coordinator.rooms.get("FIT-1234");
  coordinator.failRoom(
    "FIT-1234",
    firstState,
    "provider_timeout",
    "Final scoring timed out. Please retry.",
  );
  coordinator.requestFinalisation(guest, () => {});

  resolveRequest({
    ok: true,
    json: async () => ({
      phase: "final",
      battleId: "FIT-1234",
      finalisationId: "final-1",
      pairId: "pair-1",
    }),
  });
  await flush();

  assert.equal(coordinator.rooms.get("FIT-1234").finalisationId, "final-2");
  assert.equal(io.events.filter(({ name }) => name === "score-result").length, 1);
});

test("replays a locked result to a reconnecting player", () => {
  const { coordinator, host } = setup(async () => ({ ok: true, json: async () => ({}) }));
  const locked = { phase: "final", finalisationId: "final-1" };
  coordinator.rooms.set("FIT-1234", {
    phase: "final",
    finalisationId: "final-1",
    result: locked,
  });
  const replacement = new FakeSocket("replacement-host");

  coordinator.assignPlayer(replacement, "FIT-1234", "host");

  assert.deepEqual(replacement.events, [{ name: "score-result", payload: locked }]);
  coordinator.leave(host.id);
});

test("clears pending room work only after the room becomes empty", () => {
  const { coordinator, host, guest } = setup(async () => ({
    ok: true,
    json: async () => ({}),
  }));
  coordinator.requestFinalisation(host, () => {});

  coordinator.leave(host.id);
  assert.equal(coordinator.rooms.has("FIT-1234"), true);

  coordinator.leave(guest.id);
  assert.equal(coordinator.rooms.has("FIT-1234"), false);
});
