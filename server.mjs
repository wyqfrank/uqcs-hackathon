import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import next from "next";
import { Server as SocketIOServer } from "socket.io";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = Number(process.env.PORT || 3000);
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const requestHandler = (request, response) => handle(request, response);
const server =
  process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH
    ? createHttpsServer(
        {
          key: readFileSync(process.env.SSL_KEY_PATH),
          cert: readFileSync(process.env.SSL_CERT_PATH),
        },
        requestHandler,
      )
    : createHttpServer(requestHandler);

const io = new SocketIOServer(server, {
  cors: { origin: true, credentials: true },
});

const socketRooms = new Map();

function leaveCurrentRoom(socket) {
  const roomId = socketRooms.get(socket.id);
  if (!roomId) return;

  socket.leave(roomId);
  socketRooms.delete(socket.id);
  socket.to(roomId).emit("peer-left");
}

io.on("connection", (socket) => {
  socket.on("create-room", async ({ roomId }, acknowledge) => {
    const normalizedRoomId = String(roomId || "").toUpperCase();
    const sockets = await io.in(normalizedRoomId).fetchSockets();

    if (!/^MOG-\d{4}$/.test(normalizedRoomId)) {
      acknowledge({ ok: false, code: "invalid-code", error: "Invalid room code." });
      return;
    }

    if (sockets.length >= 2) {
      acknowledge({ ok: false, code: "room-full", error: "This battle already has two players." });
      return;
    }

    leaveCurrentRoom(socket);
    await socket.join(normalizedRoomId);
    socketRooms.set(socket.id, normalizedRoomId);
    acknowledge({ ok: true, role: "host" });
    // A creator may be reconnecting after restarting their camera. If the guest
    // stayed in the room, tell the host to make a fresh WebRTC offer.
    if (sockets.length === 1) socket.emit("peer-joined");
  });

  socket.on("join-room", async ({ roomId }, acknowledge) => {
    const normalizedRoomId = String(roomId || "").toUpperCase();
    const sockets = await io.in(normalizedRoomId).fetchSockets();

    if (sockets.length === 0) {
      // Not necessarily a bad code: the host may still be loading. The guest
      // retries on this code rather than showing a dead end straight away.
      acknowledge({ ok: false, code: "not-found", error: "Battle not found. Check the room code." });
      return;
    }

    if (sockets.length >= 2) {
      acknowledge({ ok: false, code: "room-full", error: "This battle already has two players." });
      return;
    }

    leaveCurrentRoom(socket);
    await socket.join(normalizedRoomId);
    socketRooms.set(socket.id, normalizedRoomId);
    acknowledge({ ok: true, role: "guest" });
    socket.to(normalizedRoomId).emit("peer-joined");
  });

  for (const eventName of ["webrtc-offer", "webrtc-answer", "ice-candidate"]) {
    socket.on(eventName, (payload) => {
      const roomId = socketRooms.get(socket.id);
      if (roomId) socket.to(roomId).emit(eventName, payload);
    });
  }

  socket.on("leave-room", () => leaveCurrentRoom(socket));
  socket.on("disconnecting", () => {
    const roomId = socketRooms.get(socket.id);
    if (roomId) socket.to(roomId).emit("peer-left");
    socketRooms.delete(socket.id);
  });
  socket.on("disconnect", () => socketRooms.delete(socket.id));
});

server.listen(port, hostname, () => {
  const protocol = process.env.SSL_KEY_PATH ? "https" : "http";
  const browserHost = hostname === "0.0.0.0" ? "localhost" : hostname;
  console.log(`MOG Battle ready on ${protocol}://${browserHost}:${port}`);
  if (hostname === "0.0.0.0") {
    console.log("For another laptop, use a trusted HTTPS tunnel or the LAN HTTPS setup in README.md.");
  }
});
