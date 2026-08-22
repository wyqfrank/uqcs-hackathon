import { randomUUID } from "node:crypto";

const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/webp"]);

function errorResult(roomId, state, reasonCode, message) {
  const playerA = state.pairedIdentity?.playerA ?? state.frames.player_a;
  const playerB = state.pairedIdentity?.playerB ?? state.frames.player_b;
  return {
    phase: "not_scoreable",
    intendedPhase: "final",
    battleId: roomId,
    finalisationId: state.finalisationId,
    pairId: state.pairId ?? null,
    playerASampleId: playerA?.sampleId ?? null,
    playerBSampleId: playerB?.sampleId ?? null,
    playerACapturedAtMs: playerA?.capturedAtEpochMs ?? null,
    playerBCapturedAtMs: playerB?.capturedAtEpochMs ?? null,
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
    fetchImpl = fetch,
    now = Date.now,
    createId = randomUUID,
    collectionTimeoutMs = 3000,
    inferenceTimeoutMs = 30000,
    maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  }) {
    this.io = io;
    this.inferenceUrl = inferenceUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.createId = createId;
    this.collectionTimeoutMs = collectionTimeoutMs;
    this.inferenceTimeoutMs = inferenceTimeoutMs;
    this.maxImageBytes = maxImageBytes;
    this.players = new Map();
    this.rooms = new Map();
  }

  attachSocket(socket) {
    socket.on("score-finalise", (_payload, acknowledge = () => {}) => {
      this.requestFinalisation(socket, acknowledge);
    });
    socket.on("score-frame", (payload, acknowledge = () => {}) => {
      this.submitFrame(socket, payload, acknowledge);
    });
    socket.on("score-frame-unavailable", (payload) => {
      this.reportUnavailable(socket, payload);
    });
  }

  assignPlayer(socket, roomId, role) {
    const playerRole = role === "host" ? "player_a" : "player_b";
    this.players.set(socket.id, { roomId, playerRole });
    const state = this.rooms.get(roomId);
    if (state?.phase === "final" && state.result) socket.emit("score-result", state.result);
  }

  leave(socketId) {
    const player = this.players.get(socketId);
    this.players.delete(socketId);
    if (!player) return;
    const stillOccupied = [...this.players.values()].some(
      ({ roomId }) => roomId === player.roomId,
    );
    if (!stillOccupied) this.clearRoom(player.roomId);
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

    if (existing) this.disposeState(existing);
    const finalisationId = this.createId();
    const deadlineAt = this.now() + this.collectionTimeoutMs;
    const state = {
      phase: "collecting",
      finalisationId,
      deadlineAt,
      pairId: null,
      pairedIdentity: null,
      frames: { player_a: null, player_b: null },
      result: null,
      abortController: null,
      timer: null,
    };
    state.timer = setTimeout(
      () => this.failRoom(player.roomId, state, "frame_unavailable", "A fresh outfit frame was not available. Reframe and retry."),
      this.collectionTimeoutMs,
    );
    state.timer.unref?.();
    this.rooms.set(player.roomId, state);
    this.io.to(player.roomId).emit("score-finalisation-started", {
      battleId: player.roomId,
      finalisationId,
      deadlineAt,
    });
    acknowledge({ ok: true, finalisationId, locked: false });
  }

  submitFrame(socket, payload, acknowledge) {
    const player = this.players.get(socket.id);
    if (!player) {
      acknowledge({ ok: false, error: "Join a battle before submitting a frame." });
      return;
    }
    const state = this.rooms.get(player.roomId);
    if (!state || state.phase !== "collecting" || payload?.finalisationId !== state.finalisationId) {
      acknowledge({ ok: false, error: "This finalisation is no longer active." });
      return;
    }
    if (this.now() > state.deadlineAt) {
      this.failRoom(player.roomId, state, "frame_unavailable", "The outfit frames arrived too late. Please retry.");
      acknowledge({ ok: false, error: "The frame deadline has passed." });
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

    state.frames[player.playerRole] = {
      image,
      mimeType,
      sampleId,
      capturedAtEpochMs,
      receivedAt: this.now(),
    };
    acknowledge({ ok: true });
    if (state.frames.player_a && state.frames.player_b) {
      void this.comparePair(player.roomId, state);
    }
  }

  reportUnavailable(socket, payload) {
    const player = this.players.get(socket.id);
    if (!player) return;
    const state = this.rooms.get(player.roomId);
    if (!state || state.phase !== "collecting" || payload?.finalisationId !== state.finalisationId) {
      return;
    }
    this.failRoom(
      player.roomId,
      state,
      "frame_unavailable",
      "One player did not have a stable outfit frame. Reframe and retry.",
    );
  }

  async comparePair(roomId, state) {
    if (state.phase !== "collecting") return;
    const playerA = state.frames.player_a;
    const playerB = state.frames.player_b;
    if (!playerA || !playerB) return;
    if (Math.abs(playerA.receivedAt - playerB.receivedAt) > this.collectionTimeoutMs) {
      this.failRoom(roomId, state, "pair_expired", "The outfit frames were not synchronised. Please retry.");
      return;
    }

    clearTimeout(state.timer);
    state.timer = null;
    state.phase = "analysing";
    state.pairId = this.createId();
    this.io.to(roomId).emit("score-finalisation-analysing", {
      battleId: roomId,
      finalisationId: state.finalisationId,
      pairId: state.pairId,
    });

    const form = new FormData();
    form.set("battle_id", roomId);
    form.set("finalisation_id", state.finalisationId);
    form.set("pair_id", state.pairId);
    form.set("player_a_sample_id", playerA.sampleId);
    form.set("player_b_sample_id", playerB.sampleId);
    form.set("player_a_captured_at_ms", String(playerA.capturedAtEpochMs));
    form.set("player_b_captured_at_ms", String(playerB.capturedAtEpochMs));
    form.set("player_a", new Blob([playerA.image], { type: playerA.mimeType }), "player-a.webp");
    form.set("player_b", new Blob([playerB.image], { type: playerB.mimeType }), "player-b.webp");
    state.pairedIdentity = {
      playerA: {
        sampleId: playerA.sampleId,
        capturedAtEpochMs: playerA.capturedAtEpochMs,
      },
      playerB: {
        sampleId: playerB.sampleId,
        capturedAtEpochMs: playerB.capturedAtEpochMs,
      },
    };
    state.frames = { player_a: null, player_b: null };

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
      if (
        !["final", "not_scoreable"].includes(result?.phase)
        ||
        result?.battleId !== roomId
        || result?.finalisationId !== state.finalisationId
        || result?.pairId !== state.pairId
      ) {
        this.failRoom(roomId, state, "provider_invalid_response", "Final scoring returned mismatched result identity. Please retry.");
        return;
      }
      if (this.rooms.get(roomId) !== state || state.phase !== "analysing") return;
      state.result = result;
      state.phase = result.phase === "final" ? "final" : "failed";
      state.abortController = null;
      this.io.to(roomId).emit("score-result", result);
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
  }

  clearRoom(roomId) {
    const state = this.rooms.get(roomId);
    if (state) this.disposeState(state);
    this.rooms.delete(roomId);
  }

  disposeState(state) {
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.abortController?.abort();
    state.abortController = null;
    state.frames = { player_a: null, player_b: null };
  }
}
