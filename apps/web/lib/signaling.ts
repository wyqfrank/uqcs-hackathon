import { io, type Socket } from "socket.io-client";

export type RoomRole = "host" | "guest";

export type RoomErrorCode = "invalid-code" | "not-found" | "room-full";

export type RoomAcknowledgement =
  | { ok: true; role: RoomRole }
  | { ok: false; code: RoomErrorCode; error: string };

export function createSignalingSocket(): Socket {
  return io({ transports: ["websocket", "polling"] });
}
