import type { NextConfig } from "next";

/**
 * Next blocks cross-origin requests to /_next dev resources by default. Reached
 * through a tunnel that means the HTML renders but no JavaScript loads, so the
 * page looks fine and nothing is clickable. Quick-tunnel hostnames change on
 * every restart, so allow the providers by wildcard instead of pinning a host.
 */
const TUNNEL_ORIGINS = [
  "*.trycloudflare.com",
  "*.ngrok-free.app",
  "*.ngrok.io",
  "*.loca.lt",
];

// Anything else — a LAN IP for the mkcert setup, a named tunnel — via env.
const extraOrigins = (process.env.DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: [...TUNNEL_ORIGINS, ...extraOrigins],
};

export default nextConfig;
