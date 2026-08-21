import type { CameraStatus } from "@/hooks/useCamera";
import type { ConnectionState } from "@/hooks/useWebRTC";
import { describeRoute, type IceCandidateType, type IceRoute } from "@/lib/rtcConfig";

const labels: Record<ConnectionState, string> = {
  waiting: "WAITING FOR OPPONENT",
  connecting: "CONNECTING",
  connected: "OPPONENT CONNECTED",
  disconnected: "CONNECTION LOST",
  failed: "NO ROUTE TO OPPONENT",
  error: "CONNECTION ERROR",
};

function gatheringLabel(candidateTypes: IceCandidateType[]): string | null {
  if (!candidateTypes.length) return null;
  const reach = candidateTypes.includes("relay")
    ? "TURN OK"
    : candidateTypes.includes("srflx")
      ? "STUN OK"
      : "LOCAL ONLY";
  return `ICE ${reach}`;
}

export function ConnectionStatus({
  connection,
  camera,
  candidateTypes,
  route,
}: {
  connection: ConnectionState;
  camera: CameraStatus;
  candidateTypes: IceCandidateType[];
  route: IceRoute | null;
}) {
  const cameraLabel = camera === "ready" ? "CAMERA READY" : camera === "requesting" ? "OPENING CAMERA" : ["denied", "unavailable", "error"].includes(camera) ? "CAMERA UNAVAILABLE" : "CAMERA OFF";
  // Once connected the negotiated route is the useful fact; before that, show how
  // far ICE gathering got so a dead network is visible while it is still failing.
  const routeLabel = describeRoute(route) ?? gatheringLabel(candidateTypes);
  const relayed = route ? route.local === "relay" || route.remote === "relay" : false;

  return (
    <div className="status-strip">
      <span className={`live-pill ${connection === "connected" ? "is-live" : ""}`}><i /> {connection === "connected" ? "LIVE" : "STANDBY"}</span>
      <span>{labels[connection]}</span>
      {routeLabel && (
        <>
          <span className="status-divider" />
          <span className={`route-tag ${relayed ? "is-relayed" : ""}`}>{routeLabel}</span>
        </>
      )}
      <span className="status-divider" />
      <span>{cameraLabel}</span>
    </div>
  );
}
