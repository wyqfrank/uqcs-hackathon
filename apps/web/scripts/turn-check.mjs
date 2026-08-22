/**
 * Verifies the STUN/TURN setup this app will actually use.
 *
 * For Cloudflare it mints real credentials through the API, which validates the
 * key id and token, then probes the relay hosts that come back. For static
 * credentials it can only prove the host is alive — confirm those on
 * /diagnostics, which reports whether `relay` candidates were gathered.
 *
 *   npm run test:turn
 */
import { createSocket } from "node:dgram";
import { randomBytes } from "node:crypto";

const TIMEOUT_MS = 3000;
const CREDENTIAL_TTL_SECONDS = 3600;

const STUN_TARGETS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

function parseTarget(url) {
  // turn:host:port?transport=tcp  ->  { host, port, transport }
  const rest = url.slice(url.indexOf(":") + 1);
  const [hostPort, query = ""] = rest.split("?");
  const lastColon = hostPort.lastIndexOf(":");
  const host = lastColon === -1 ? hostPort : hostPort.slice(0, lastColon);
  const port = lastColon === -1 ? 3478 : Number(hostPort.slice(lastColon + 1));
  const transport = query.includes("transport=tcp") || url.startsWith("turns:") ? "tcp" : "udp";
  return { host, port, transport };
}

function bindingRequest({ host, port }) {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const packet = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x00, 0x00]), // binding request, length 0
      Buffer.from([0x21, 0x12, 0xa4, 0x42]), // magic cookie
      randomBytes(12), // transaction id
    ]);

    const settle = (outcome) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => settle({ ok: false, note: `no response in ${TIMEOUT_MS}ms` }),
      TIMEOUT_MS,
    );

    socket.on("message", (message) => {
      const type = message.readUInt16BE(0);
      settle(
        type === 0x0101
          ? { ok: true, note: "binding success" }
          : { ok: true, note: `unexpected type 0x${type.toString(16)}` },
      );
    });
    socket.on("error", (error) => settle({ ok: false, note: error.message }));
    socket.send(packet, port, host);
  });
}

async function mintCloudflareCredentials(keyId, apiToken) {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
    },
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`HTTP ${response.status} — ${detail}`);
  }

  const payload = await response.json();
  const servers = Array.isArray(payload.iceServers)
    ? payload.iceServers
    : payload.iceServers
      ? [payload.iceServers]
      : [];
  return servers.flatMap((server) =>
    (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(Boolean),
  );
}

const env = (name) => (process.env[name] ?? "").trim();

const cloudflareKeyId = env("CLOUDFLARE_TURN_KEY_ID");
const cloudflareToken = env("CLOUDFLARE_TURN_API_TOKEN");
const staticUrls = env("NEXT_PUBLIC_TURN_URLS")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const hasStaticCredentials = Boolean(
  env("NEXT_PUBLIC_TURN_USERNAME") && env("NEXT_PUBLIC_TURN_CREDENTIAL"),
);

let failures = 0;
let turnUrls = [];
let summary;

console.log("\nSTUN / TURN reachability\n");

if (cloudflareKeyId && cloudflareToken) {
  try {
    turnUrls = await mintCloudflareCredentials(cloudflareKeyId, cloudflareToken);
    console.log(`  Cloudflare credentials       OK — minted, ${turnUrls.length} ICE URLs returned`);
    summary = "Cloudflare credentials are valid. Confirm `relay` candidates appear on /diagnostics.";
  } catch (error) {
    failures += 1;
    console.log(`  Cloudflare credentials       FAIL — ${error.message}`);
    summary = "Check CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_API_TOKEN in .env.local.";
  }
} else if (staticUrls.length) {
  turnUrls = staticUrls;
  summary = hasStaticCredentials
    ? "Static credentials are not validated here. Confirm `relay` candidates appear on /diagnostics."
    : "TURN URLs are set but username/credential are missing — relay candidates will not gather.";
} else {
  summary =
    "No TURN configured. STUN alone fails on networks with client isolation or symmetric NAT. See .env.example.";
}

for (const url of [...STUN_TARGETS, ...turnUrls]) {
  const target = parseTarget(url);
  const label = url.length > 46 ? `${url.slice(0, 45)}…` : url;
  if (target.transport === "tcp") {
    console.log(`  ${label.padEnd(48)} skipped (TCP — verify on /diagnostics)`);
    continue;
  }
  const { ok, note } = await bindingRequest(target);
  if (!ok) failures += 1;
  console.log(`  ${label.padEnd(48)} ${ok ? "OK" : "FAIL"} — ${note}`);
}

console.log(`\n  ${summary}\n`);
process.exit(failures > 0 ? 1 : 0);
