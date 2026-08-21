import { io, type Socket } from "socket.io-client";

export type RoomRole = "host" | "guest";

export type RoomAcknowledgement =
  | { ok: true; role: RoomRole }
  | { ok: false; error: string };

export function createSignalingSocket(): Socket {
  return io({ transports: ["websocket", "polling"] });
}
