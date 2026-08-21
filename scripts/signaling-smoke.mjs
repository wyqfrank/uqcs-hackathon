import { io } from "socket.io-client";

const url = process.env.TEST_SERVER_URL || "http://localhost:3000";
const roomId = "FIT-9001";
const clients = [io(url), io(url), io(url)];

function emitWithAck(client, event, payload) {
  return new Promise((resolve) => client.emit(event, payload, resolve));
}

try {
  await Promise.all(clients.map((client) => new Promise((resolve) => client.on("connect", resolve))));
  const created = await emitWithAck(clients[0], "create-room", { roomId });
  const joined = await emitWithAck(clients[1], "join-room", { roomId });
  const rejected = await emitWithAck(clients[2], "join-room", { roomId });

  const relayed = new Promise((resolve) => clients[1].once("webrtc-offer", resolve));
  const fakeOffer = { type: "offer", sdp: "smoke-test" };
  clients[0].emit("webrtc-offer", fakeOffer);
  const received = await relayed;

  const peerLeft = new Promise((resolve) => clients[1].once("peer-left", resolve));
  clients[0].emit("leave-room");
  await peerLeft;
  const reconnectPrompt = new Promise((resolve) => clients[0].once("peer-joined", resolve));
  const recreated = await emitWithAck(clients[0], "create-room", { roomId });
  await reconnectPrompt;

  if (!created.ok || !joined.ok || rejected.ok || !recreated.ok || received.sdp !== fakeOffer.sdp) {
    throw new Error("Unexpected signalling result.");
  }
  console.log("Signalling smoke test passed: create, join, capacity, SDP relay, and reconnect.");
} finally {
  clients.forEach((client) => client.disconnect());
}
