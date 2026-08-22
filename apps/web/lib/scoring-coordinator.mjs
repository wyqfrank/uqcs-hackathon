import { randomUUID } from "node:crypto";

const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_BURST_BYTES = 15 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/webp"]);

function errorResult(roomId, state, reasonCode, message) {
  const samplePairs = state.pairedIdentity ?? [];
  const latest = samplePairs.at(-1);
  return {
    phase: "not_scoreable",
    intendedPhase: "final",
    battleId: roomId,
    finalisationId: state.finalisationId,
    pairId: state.pairId ?? null,
    playerASampleId: latest?.playerA.sampleId ?? null,
    playerBSampleId: latest?.playerB.sampleId ?? null,
    playerACapturedAtMs: latest?.playerA.capturedAtEpochMs ?? null,
    playerBCapturedAtMs: latest?.playerB.capturedAtEpochMs ?? null,
    samplePairs: samplePairs.map((pair) => ({
      burstIndex: pair.burstIndex,
      playerASampleId: pair.playerA.sampleId,
      playerBSampleId: pair.playerB.sampleId,
      playerACapturedAtMs: pair.playerA.capturedAtEpochMs,
      playerBCapturedAtMs: pair.playerB.capturedAtEpochMs,
    })),
    reasonCode,
    message,
    retryable: true,
    modelVersion: null,
    promptVersion: null,
    latencyMs: 0,
  };
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

export class ScoringCoordinator {
  constructor({
    io,
    inferenceUrl,
    leaderboard = null,
    fetchImpl = fetch,
    now = Date.now,
    createId = randomUUID,
    roundDurationMs = 30000,
    collectionTimeoutMs = 3000,
    burstOffsetsMs = [0, 750, 1500],
    burstSlotTimeoutMs = 650,
    inferenceTimeoutMs = 30000,
    perceptionIntervalMs = 1000,
    perceptionTimeoutMs = 5000,
    maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
    maxBurstBytes = DEFAULT_MAX_BURST_BYTES,
  }) {
    this.io = io;
    this.inferenceUrl = inferenceUrl.replace(/\/$/, "");
    this.leaderboard = leaderboard;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.createId = createId;
    this.roundDurationMs = roundDurationMs;
    this.collectionTimeoutMs = collectionTimeoutMs;
    this.burstOffsetsMs = [...burstOffsetsMs];
    this.burstSlotTimeoutMs = burstSlotTimeoutMs;
    this.inferenceTimeoutMs = inferenceTimeoutMs;
    this.perceptionIntervalMs = perceptionIntervalMs;
    this.perceptionTimeoutMs = perceptionTimeoutMs;
    this.maxImageBytes = maxImageBytes;
    this.maxBurstBytes = maxBurstBytes;
    this.players = new Map();
    this.readinessRooms = new Map();
    this.rooms = new Map();
    this.perceptionRooms = new Map();
  }

  attachSocket(socket) {
    socket.on("score-readiness", (payload, acknowledge = () => {}) => {
      this.reportReadiness(socket, payload, acknowledge);
    });
    socket.on("score-finalise", (_payload, acknowledge = () => {}) => {
      this.requestFinalisation(socket, acknowledge);
    });
    socket.on("score-frame", (payload, acknowledge = () => {}) => {
      this.submitFrame(socket, payload, acknowledge);
    });
    socket.on("score-frame-unavailable", (payload) => {
      this.reportUnavailable(socket, payload);
    });
    socket.on("garment-frame", (payload, acknowledge = () => {}) => {
      this.submitGarmentFrame(socket, payload, acknowledge);
    });
    socket.on("garment-frame-unavailable", (payload) => {
      this.reportGarmentFrameUnavailable(socket, payload);
    });
  }

  assignPlayer(socket, roomId, role, displayName = "") {
    const playerRole = role === "host" ? "player_a" : "player_b";
    this.players.set(socket.id, { roomId, playerRole, displayName });
    const readiness = this.ensureReadiness(roomId);
    readiness[playerRole] = false;
    const state = this.rooms.get(roomId);
    if (state?.phase === "final" && state.result) socket.emit("score-result", state.result);
    if (state?.phase === "failed" && state.result) socket.emit("score-result", state.result);
    if (state?.phase === "countdown") {
      socket.emit("score-round-started", this.roundPayload(roomId, state));
    }
    socket.emit("score-readiness-updated", {
      battleId: roomId,
      playerAReady: readiness.player_a,
      playerBReady: readiness.player_b,
    });
    const perception = this.perceptionRooms.get(roomId);
    if (perception?.result) socket.emit("garment-result", perception.result);
    const playerCount = [...this.players.values()].filter(
      ({ roomId: assignedRoom }) => assignedRoom === roomId,
    ).length;
    if (playerCount >= 2 && state?.phase !== "final") this.startPerception(roomId);
  }

  /**
   * Credits both players once a battle reaches an authoritative result. Recorded
   * server-side from the single finalisation, so neither client can inflate its
   * own record and a draw credits nobody a win.
   */
  recordStandings(roomId, result) {
    if (!this.leaderboard) return;
    const named = new Map();
    for (const player of this.players.values()) {
      if (player.roomId === roomId && player.displayName) {
        named.set(player.playerRole, player.displayName);
      }
    }

    const players = [
      { role: "player_a", score: result.playerAScore },
      { role: "player_b", score: result.playerBScore },
    ]
      .filter(({ role }) => named.has(role))
      .map(({ role, score }) => ({
        name: named.get(role),
        score: Number.isFinite(score) ? score : 0,
        won: result.winner === role,
      }));

    if (!players.length) return;
    Promise.resolve(this.leaderboard.recordBattle(players)).catch((error) => {
      // A leaderboard write must never take the battle down with it.
      console.error("Could not record battle standings:", error?.message ?? error);
    });
  }

  leave(socketId) {
    const player = this.players.get(socketId);
    this.players.delete(socketId);
    if (!player) return;
    const readiness = this.ensureReadiness(player.roomId);
    readiness[player.playerRole] = false;
    this.io.to(player.roomId).emit("score-readiness-updated", {
      battleId: player.roomId,
      playerAReady: readiness.player_a,
      playerBReady: readiness.player_b,
    });
    const roomState = this.rooms.get(player.roomId);
    if (roomState && ["countdown", "collecting", "analysing"].includes(roomState.phase)) {
      this.disposeState(roomState);
      this.rooms.delete(player.roomId);
      this.io.to(player.roomId).emit("score-round-cancelled", {
        battleId: player.roomId,
        roundId: roomState.roundId ?? null,
        reason: "player_disconnected",
      });
    }
    const stillOccupied = [...this.players.values()].some(
      ({ roomId }) => roomId === player.roomId,
    );
    if (!stillOccupied) {
      this.clearRoom(player.roomId);
      return;
    }
    this.stopPerception(player.roomId);
  }

  ensureReadiness(roomId) {
    let readiness = this.readinessRooms.get(roomId);
    if (!readiness) {
      readiness = { player_a: false, player_b: false };
      this.readinessRooms.set(roomId, readiness);
    }
    return readiness;
  }

  reportReadiness(socket, payload, acknowledge) {
    const player = this.players.get(socket.id);
    if (!player) {
      acknowledge({ ok: false, error: "Join a battle before reporting readiness." });
      return;
    }
    const readiness = this.ensureReadiness(player.roomId);
    readiness[player.playerRole] = payload?.ready === true;
    this.io.to(player.roomId).emit("score-readiness-updated", {
      battleId: player.roomId,
      playerAReady: readiness.player_a,
      playerBReady: readiness.player_b,
    });
    acknowledge({ ok: true });
    const state = this.rooms.get(player.roomId);
    if (readiness.player_a && readiness.player_b && !state) {
      this.startRound(player.roomId);
    }
  }

  roundPayload(roomId, state) {
    return {
      battleId: roomId,
      roundId: state.roundId,
      serverNow: this.now(),
      endsAt: state.endsAt,
    };
  }

  startRound(roomId) {
    if (this.rooms.has(roomId)) return;
    const state = {
      phase: "countdown",
      roundId: this.createId(),
      endsAt: this.now() + this.roundDurationMs,
      timer: null,
      slotTimers: [],
      abortController: null,
      result: null,
      pairedIdentity: [],
    };
    state.timer = setTimeout(() => {
      if (this.rooms.get(roomId) === state && state.phase === "countdown") {
        this.beginFinalisation(roomId, state);
      }
    }, this.roundDurationMs);
    state.timer.unref?.();
    this.rooms.set(roomId, state);
    this.io.to(roomId).emit("score-round-started", this.roundPayload(roomId, state));
  }

  requestFinalisation(socket, acknowledge) {
    const player = this.players.get(socket.id);
    if (!player) {
      acknowledge({ ok: false, error: "Join a battle before finalising." });
      return;
    }
    const playerCount = [...this.players.values()].filter(
      ({ roomId }) => roomId === player.roomId,
    ).length;
    if (playerCount < 2) {
      acknowledge({ ok: false, error: "Wait for both players before finalising." });
      return;
    }

    const existing = this.rooms.get(player.roomId);
    if (existing?.phase === "final") {
      socket.emit("score-result", existing.result);
      acknowledge({ ok: true, finalisationId: existing.finalisationId, locked: true });
      return;
    }
    if (existing && ["collecting", "analysing"].includes(existing.phase)) {
      acknowledge({ ok: true, finalisationId: existing.finalisationId, locked: false });
      return;
    }

    if (!existing || !["countdown", "failed"].includes(existing.phase)) {
      acknowledge({ ok: false, error: "Wait for the battle countdown before finalising." });
      return;
    }

    const finalisationId = this.beginFinalisation(player.roomId, existing);
    acknowledge({ ok: true, finalisationId, locked: false });
  }

  beginFinalisation(roomId, existing) {
    if (this.rooms.get(roomId) !== existing) return existing.finalisationId ?? null;
    this.disposeState(existing);
    this.stopPerception(roomId);
    const finalisationId = this.createId();
    const deadlineAt = this.now() + this.collectionTimeoutMs;
    const state = {
      phase: "collecting",
      roundId: existing.roundId ?? null,
      finalisationId,
      deadlineAt,
      pairId: null,
      pairedIdentity: [],
      slots: this.burstOffsetsMs.map((offsetMs, burstIndex) => ({
        burstIndex,
        offsetMs,
        requestId: this.createId(),
        deadlineAt: null,
        requested: false,
        settled: false,
        responses: { player_a: "pending", player_b: "pending" },
        frames: { player_a: null, player_b: null },
      })),
      result: null,
      abortController: null,
      timer: null,
      slotTimers: [],
      totalImageBytes: 0,
    };
    state.timer = setTimeout(
      () => this.finishBurstCollection(roomId, state),
      this.collectionTimeoutMs,
    );
    state.timer.unref?.();
    this.rooms.set(roomId, state);
    this.io.to(roomId).emit("score-finalisation-started", {
      battleId: roomId,
      finalisationId,
      deadlineAt,
      burstCount: state.slots.length,
    });
    for (const slot of state.slots) {
      const timer = setTimeout(
        () => this.requestBurstSlot(roomId, state, slot),
        slot.offsetMs,
      );
      timer.unref?.();
      state.slotTimers.push(timer);
    }
    return finalisationId;
  }

  startPerception(roomId) {
    if (this.perceptionRooms.has(roomId)) return;
    const state = {
      timer: null,
      requestId: null,
      deadlineAt: 0,
      frames: { player_a: null, player_b: null },
      inFlight: false,
      abortController: null,
      result: null,
    };
    state.timer = setInterval(
      () => this.requestGarmentFrames(roomId, state),
      this.perceptionIntervalMs,
    );
    state.timer.unref?.();
    this.perceptionRooms.set(roomId, state);
  }

  requestGarmentFrames(roomId, state = this.perceptionRooms.get(roomId)) {
    if (!state || this.perceptionRooms.get(roomId) !== state || state.inFlight) return;
    const scoringState = this.rooms.get(roomId);
    if (scoringState && ["collecting", "analysing", "final"].includes(scoringState.phase)) {
      return;
    }
    if (state.requestId && this.now() <= state.deadlineAt) return;
    state.requestId = this.createId();
    state.deadlineAt = this.now() + this.collectionTimeoutMs;
    state.frames = { player_a: null, player_b: null };
    this.io.to(roomId).emit("garment-frame-request", {
      battleId: roomId,
      requestId: state.requestId,
      deadlineAt: state.deadlineAt,
    });
  }

  submitGarmentFrame(socket, payload, acknowledge) {
    const player = this.players.get(socket.id);
    if (!player) {
      acknowledge({ ok: false, error: "Join a battle before submitting garment frames." });
      return;
    }
    const scoringState = this.rooms.get(player.roomId);
    if (scoringState && ["collecting", "analysing", "final"].includes(scoringState.phase)) {
      acknowledge({ ok: false, paused: true, error: "Garment perception is paused." });
      return;
    }
    const state = this.perceptionRooms.get(player.roomId);
    if (
      !state
      || state.inFlight
      || !state.requestId
      || payload?.requestId !== state.requestId
      || this.now() > state.deadlineAt
    ) {
      acknowledge({ ok: false, error: "This garment sample is stale or busy." });
      return;
    }

    const image = toBuffer(payload?.image);
    const mimeType = String(payload?.mimeType || "");
    const sampleId = String(payload?.sampleId || "");
    const capturedAtEpochMs = Number(payload?.capturedAtEpochMs);
    if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
      acknowledge({ ok: false, error: "Garment frames must be JPEG or WebP." });
      return;
    }
    if (!image?.length || image.length > this.maxImageBytes) {
      acknowledge({ ok: false, error: "Garment frame size is invalid." });
      return;
    }
    if (!sampleId || sampleId.length > 128 || !Number.isFinite(capturedAtEpochMs)) {
      acknowledge({ ok: false, error: "Garment frame metadata is invalid." });
      return;
    }

    state.frames[player.playerRole] = {
      image,
      mimeType,
      sampleId,
      capturedAtEpochMs,
      receivedAt: this.now(),
    };
    acknowledge({ ok: true });
    if (state.frames.player_a && state.frames.player_b) {
      void this.compareGarmentPair(player.roomId, state);
    }
  }

  reportGarmentFrameUnavailable(socket, payload) {
    const player = this.players.get(socket.id);
    if (!player) return;
    const state = this.perceptionRooms.get(player.roomId);
    if (!state || payload?.requestId !== state.requestId || state.inFlight) return;
    state.requestId = null;
    state.deadlineAt = 0;
    state.frames = { player_a: null, player_b: null };
  }

  async compareGarmentPair(roomId, state) {
    if (this.perceptionRooms.get(roomId) !== state || state.inFlight) return;
    const playerA = state.frames.player_a;
    const playerB = state.frames.player_b;
    if (!playerA || !playerB || !state.requestId) return;
    if (Math.abs(playerA.receivedAt - playerB.receivedAt) > this.collectionTimeoutMs) {
      state.requestId = null;
      state.frames = { player_a: null, player_b: null };
      return;
    }

    const pairId = state.requestId;
    state.inFlight = true;
    state.requestId = null;
    state.deadlineAt = 0;
    state.frames = { player_a: null, player_b: null };

    const form = new FormData();
    form.set("battle_id", roomId);
    form.set("pair_id", pairId);
    form.set("player_a_sample_id", playerA.sampleId);
    form.set("player_b_sample_id", playerB.sampleId);
    form.set("player_a_captured_at_ms", String(playerA.capturedAtEpochMs));
    form.set("player_b_captured_at_ms", String(playerB.capturedAtEpochMs));
    form.set("player_a", new Blob([playerA.image], { type: playerA.mimeType }), "player-a.webp");
    form.set("player_b", new Blob([playerB.image], { type: playerB.mimeType }), "player-b.webp");

    const abortController = new AbortController();
    state.abortController = abortController;
    const timeout = setTimeout(() => abortController.abort(), this.perceptionTimeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(`${this.inferenceUrl}/v1/garments/pair`, {
        method: "POST",
        body: form,
        signal: abortController.signal,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        this.io.to(roomId).emit("garment-unavailable", {
          battleId: roomId,
          message: typeof detail.detail === "string" ? detail.detail : "Garment perception is unavailable.",
        });
        if (response.status === 503) this.stopPerception(roomId);
        return;
      }
      const result = await response.json();
      if (
        result?.battleId !== roomId
        || result?.pairId !== pairId
        || result?.playerASampleId !== playerA.sampleId
        || result?.playerBSampleId !== playerB.sampleId
      ) {
        this.io.to(roomId).emit("garment-unavailable", {
          battleId: roomId,
          message: "Garment perception returned mismatched sample identity.",
        });
        return;
      }
      if (this.perceptionRooms.get(roomId) !== state) return;
      state.result = result;
      this.io.to(roomId).emit("garment-result", result);
    } catch (error) {
      if (this.perceptionRooms.get(roomId) !== state || error?.name === "AbortError") return;
      this.io.to(roomId).emit("garment-unavailable", {
        battleId: roomId,
        message: "Garment perception is unavailable.",
      });
    } finally {
      clearTimeout(timeout);
      if (this.perceptionRooms.get(roomId) === state) {
        state.inFlight = false;
        state.abortController = null;
      }
    }
  }

  requestBurstSlot(roomId, state, slot) {
    if (this.rooms.get(roomId) !== state || state.phase !== "collecting" || slot.requested) {
      return;
    }
    slot.requested = true;
    slot.deadlineAt = Math.min(this.now() + this.burstSlotTimeoutMs, state.deadlineAt);
    this.io.to(roomId).emit("score-frame-request", {
      battleId: roomId,
      finalisationId: state.finalisationId,
      requestId: slot.requestId,
      burstIndex: slot.burstIndex,
      serverNow: this.now(),
      deadlineAt: slot.deadlineAt,
    });
    const timer = setTimeout(
      () => this.settleBurstSlot(roomId, state, slot),
      Math.max(0, slot.deadlineAt - this.now()),
    );
    timer.unref?.();
    state.slotTimers.push(timer);
  }

  findBurstSlot(state, payload) {
    const burstIndex = Number(payload?.burstIndex);
    if (!Number.isInteger(burstIndex)) return null;
    const slot = state.slots?.[burstIndex];
    return slot?.requestId === payload?.requestId ? slot : null;
  }

  submitFrame(socket, payload, acknowledge) {
    const player = this.players.get(socket.id);
    if (!player) {
      acknowledge({ ok: false, error: "Join a battle before submitting a frame." });
      return;
    }
    const state = this.rooms.get(player.roomId);
    const slot = state?.phase === "collecting" ? this.findBurstSlot(state, payload) : null;
    if (
      !state
      || state.phase !== "collecting"
      || payload?.finalisationId !== state.finalisationId
      || !slot?.requested
      || slot.settled
    ) {
      acknowledge({ ok: false, error: "This capture request is no longer active." });
      return;
    }
    if (this.now() > slot.deadlineAt || this.now() > state.deadlineAt) {
      acknowledge({ ok: false, error: "The capture deadline has passed." });
      return;
    }

    const image = toBuffer(payload?.image);
    const mimeType = String(payload?.mimeType || "");
    const sampleId = String(payload?.sampleId || "");
    const capturedAtEpochMs = Number(payload?.capturedAtEpochMs);
    if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
      acknowledge({ ok: false, error: "Final frames must be JPEG or WebP." });
      return;
    }
    if (!image?.length || image.length > this.maxImageBytes) {
      acknowledge({ ok: false, error: "Final frame size is invalid." });
      return;
    }
    if (!sampleId || sampleId.length > 128 || !Number.isFinite(capturedAtEpochMs)) {
      acknowledge({ ok: false, error: "Final frame metadata is invalid." });
      return;
    }
    if (slot.responses[player.playerRole] === "unavailable") {
      acknowledge({ ok: false, error: "This player already declined the capture request." });
      return;
    }

    const previous = slot.frames[player.playerRole];
    const nextTotal = state.totalImageBytes - (previous?.image.length ?? 0) + image.length;
    if (nextTotal > this.maxBurstBytes) {
      acknowledge({ ok: false, error: "Final image burst is too large." });
      return;
    }
    state.totalImageBytes = nextTotal;
    slot.frames[player.playerRole] = {
      image,
      mimeType,
      sampleId,
      capturedAtEpochMs,
      receivedAt: this.now(),
    };
    slot.responses[player.playerRole] = "frame";
    acknowledge({ ok: true });
  }

  reportUnavailable(socket, payload) {
    const player = this.players.get(socket.id);
    if (!player) return;
    const state = this.rooms.get(player.roomId);
    const slot = state?.phase === "collecting" ? this.findBurstSlot(state, payload) : null;
    if (
      !state
      || state.phase !== "collecting"
      || payload?.finalisationId !== state.finalisationId
      || !slot?.requested
      || slot.settled
      || slot.responses[player.playerRole] !== "pending"
    ) {
      return;
    }
    slot.responses[player.playerRole] = "unavailable";
    if (Object.values(slot.responses).every((response) => response !== "pending")) {
      this.settleBurstSlot(player.roomId, state, slot);
    }
  }

  settleBurstSlot(roomId, state, slot) {
    if (this.rooms.get(roomId) !== state || state.phase !== "collecting" || slot.settled) {
      return;
    }
    slot.settled = true;
    if (!slot.frames.player_a || !slot.frames.player_b) {
      state.totalImageBytes -=
        (slot.frames.player_a?.image.length ?? 0) + (slot.frames.player_b?.image.length ?? 0);
      slot.frames = { player_a: null, player_b: null };
    }
    if (state.slots.every((candidate) => candidate.requested && candidate.settled)) {
      this.finishBurstCollection(roomId, state);
    }
  }

  finishBurstCollection(roomId, state) {
    if (this.rooms.get(roomId) !== state || state.phase !== "collecting") return;
    for (const slot of state.slots) {
      if (slot.settled) continue;
      slot.settled = true;
      if (!slot.frames.player_a || !slot.frames.player_b) {
        state.totalImageBytes -=
          (slot.frames.player_a?.image.length ?? 0) + (slot.frames.player_b?.image.length ?? 0);
        slot.frames = { player_a: null, player_b: null };
      }
    }
    const completePairs = state.slots
      .filter((slot) => slot.frames.player_a && slot.frames.player_b)
      .map((slot) => ({
        burstIndex: slot.burstIndex,
        playerA: slot.frames.player_a,
        playerB: slot.frames.player_b,
      }));
    if (!completePairs.length) {
      this.failRoom(
        roomId,
        state,
        "frame_unavailable",
        "Could not capture both camera feeds. Check both cameras and retry.",
      );
      return;
    }
    void this.compareBurst(roomId, state, completePairs);
  }

  async compareBurst(roomId, state, completePairs) {
    if (this.rooms.get(roomId) !== state || state.phase !== "collecting") return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    for (const timer of state.slotTimers) clearTimeout(timer);
    state.slotTimers = [];
    state.phase = "analysing";
    state.pairId = this.createId();
    this.io.to(roomId).emit("score-finalisation-analysing", {
      battleId: roomId,
      finalisationId: state.finalisationId,
      pairId: state.pairId,
      sampleCount: completePairs.length,
    });

    const form = new FormData();
    form.set("battle_id", roomId);
    form.set("finalisation_id", state.finalisationId);
    form.set("pair_id", state.pairId);
    for (const pair of completePairs) {
      form.append("burst_index", String(pair.burstIndex));
      form.append("player_a_sample_id", pair.playerA.sampleId);
      form.append("player_b_sample_id", pair.playerB.sampleId);
      form.append("player_a_captured_at_ms", String(pair.playerA.capturedAtEpochMs));
      form.append("player_b_captured_at_ms", String(pair.playerB.capturedAtEpochMs));
      form.append(
        "player_a",
        new Blob([pair.playerA.image], { type: pair.playerA.mimeType }),
        `player-a-${pair.burstIndex}.webp`,
      );
      form.append(
        "player_b",
        new Blob([pair.playerB.image], { type: pair.playerB.mimeType }),
        `player-b-${pair.burstIndex}.webp`,
      );
    }
    state.pairedIdentity = completePairs.map((pair) => ({
      burstIndex: pair.burstIndex,
      playerA: {
        sampleId: pair.playerA.sampleId,
        capturedAtEpochMs: pair.playerA.capturedAtEpochMs,
      },
      playerB: {
        sampleId: pair.playerB.sampleId,
        capturedAtEpochMs: pair.playerB.capturedAtEpochMs,
      },
    }));
    state.slots = [];
    state.totalImageBytes = 0;

    const abortController = new AbortController();
    state.abortController = abortController;
    const timeout = setTimeout(() => abortController.abort(), this.inferenceTimeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetchImpl(`${this.inferenceUrl}/v1/compare`, {
        method: "POST",
        body: form,
        signal: abortController.signal,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const message = typeof detail.detail === "string" ? detail.detail : "Final scoring is unavailable.";
        const reason = response.status === 504 ? "provider_timeout" : response.status === 503 ? "provider_unavailable" : "invalid_request";
        this.failRoom(roomId, state, reason, message);
        return;
      }
      const result = await response.json();
      const identitiesMatch = Array.isArray(result?.samplePairs)
        && result.samplePairs.length === state.pairedIdentity.length
        && result.samplePairs.every((sample, index) => {
          const expected = state.pairedIdentity[index];
          return sample.burstIndex === expected.burstIndex
            && sample.playerASampleId === expected.playerA.sampleId
            && sample.playerBSampleId === expected.playerB.sampleId;
        });
      if (
        !["final", "not_scoreable"].includes(result?.phase)
        || result?.battleId !== roomId
        || result?.finalisationId !== state.finalisationId
        || result?.pairId !== state.pairId
        || !identitiesMatch
      ) {
        this.failRoom(roomId, state, "provider_invalid_response", "Final scoring returned mismatched result identity. Please retry.");
        return;
      }
      if (this.rooms.get(roomId) !== state || state.phase !== "analysing") return;
      state.result = result;
      state.phase = result.phase === "final" ? "final" : "failed";
      state.abortController = null;
      this.io.to(roomId).emit("score-result", result);
      if (state.phase === "final") this.recordStandings(roomId, result);
      if (state.phase === "failed") this.startPerception(roomId);
    } catch (error) {
      if (this.rooms.get(roomId) !== state) return;
      const timedOut = error?.name === "AbortError";
      this.failRoom(
        roomId,
        state,
        timedOut ? "provider_timeout" : "provider_unavailable",
        timedOut ? "Final scoring timed out. Please retry." : "Final scoring is unavailable. Please retry.",
      );
    } finally {
      clearTimeout(timeout);
      if (state.abortController === abortController) state.abortController = null;
    }
  }

  failRoom(roomId, state, reasonCode, message) {
    if (this.rooms.get(roomId) !== state || state.phase === "final" || state.phase === "failed") {
      return;
    }
    const result = errorResult(roomId, state, reasonCode, message);
    this.disposeState(state);
    state.phase = "failed";
    state.result = result;
    this.io.to(roomId).emit("score-result", state.result);
    this.startPerception(roomId);
  }

  clearRoom(roomId) {
    const state = this.rooms.get(roomId);
    if (state) this.disposeState(state);
    this.rooms.delete(roomId);
    this.readinessRooms.delete(roomId);
    this.stopPerception(roomId);
  }

  stopPerception(roomId) {
    const state = this.perceptionRooms.get(roomId);
    if (!state) return;
    this.perceptionRooms.delete(roomId);
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.abortController?.abort();
    state.abortController = null;
    state.frames = { player_a: null, player_b: null };
  }

  disposeState(state) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    for (const timer of state.slotTimers ?? []) clearTimeout(timer);
    state.slotTimers = [];
    state.abortController?.abort();
    state.abortController = null;
    for (const slot of state.slots ?? []) {
      slot.frames = { player_a: null, player_b: null };
    }
    state.slots = [];
    if (state.frames) state.frames = { player_a: null, player_b: null };
  }
}
