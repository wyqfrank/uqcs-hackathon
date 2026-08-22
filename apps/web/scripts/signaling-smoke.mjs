import { spawn } from "node:child_process";

import { io } from "socket.io-client";

const testPort = process.env.TEST_SERVER_PORT || "3100";
const managedServer = !process.env.TEST_SERVER_URL;
const url = process.env.TEST_SERVER_URL || `http://localhost:${testPort}`;
const roomId = "FIT-9001";
let server;

function withTimeout(promise, label, timeoutMs = 10_000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)), timeoutMs),
    ),
  ]);
}

async function startServer() {
  server = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: testPort },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await withTimeout(
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.once("exit", (code) => reject(new Error(`Test server exited with code ${code}.`)));
      server.stdout.on("data", (chunk) => {
        const message = chunk.toString();
        process.stdout.write(message);
        if (message.includes("FITTED Battle ready")) resolve();
      });
      server.stderr.on("data", (chunk) => process.stderr.write(chunk));
    }),
    "Signalling server startup",
    30_000,
  );
}

function connect(client) {
  return withTimeout(
    new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    }),
    "Socket connection",
  );
}

function emitWithAck(client, event, payload) {
  return withTimeout(
    new Promise((resolve) => client.emit(event, payload, resolve)),
    `${event} acknowledgement`,
  );
}

if (managedServer) await startServer();

const clients = Array.from({ length: 3 }, () =>
  io(url, { autoConnect: false, reconnection: false, timeout: 5_000 }),
);

try {
  await Promise.all(
    clients.map((client) => {
      const connected = connect(client);
      client.connect();
      return connected;
    }),
  );

  const created = await emitWithAck(clients[0], "create-room", { roomId });
  const joined = await emitWithAck(clients[1], "join-room", { roomId });
  const rejected = await emitWithAck(clients[2], "join-room", { roomId });

  const relayed = withTimeout(
    new Promise((resolve) => clients[1].once("webrtc-offer", resolve)),
    "WebRTC offer relay",
  );
  const fakeOffer = { type: "offer", sdp: "smoke-test" };
  clients[0].emit("webrtc-offer", fakeOffer);
  const received = await relayed;

  const peerLeft = withTimeout(
    new Promise((resolve) => clients[1].once("peer-left", resolve)),
    "Peer-left event",
  );
  clients[0].emit("leave-room");
  await peerLeft;

  const reconnectPrompt = withTimeout(
    new Promise((resolve) => clients[0].once("peer-joined", resolve)),
    "Reconnect prompt",
  );
  const recreated = await emitWithAck(clients[0], "create-room", { roomId });
  await reconnectPrompt;

  if (!created.ok || !joined.ok || rejected.ok || !recreated.ok || received.sdp !== fakeOffer.sdp) {
    throw new Error("Unexpected signalling result.");
  }
  console.log("Signalling smoke test passed: create, join, capacity, SDP relay, and reconnect.");
} finally {
  clients.forEach((client) => client.disconnect());
  server?.kill("SIGTERM");
}
