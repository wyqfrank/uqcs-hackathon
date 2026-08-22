import type { CameraStatus } from "@/hooks/useCamera";
import type { ConnectionState } from "@/hooks/useWebRTC";

const labels: Record<ConnectionState, string> = {
  waiting: "WAITING FOR OPPONENT",
  connecting: "CONNECTING",
  connected: "OPPONENT CONNECTED",
  disconnected: "CONNECTION LOST",
  error: "CONNECTION ERROR",
};

export function ConnectionStatus({ connection, camera }: { connection: ConnectionState; camera: CameraStatus }) {
  const cameraLabel = camera === "ready" ? "CAMERA READY" : camera === "requesting" ? "OPENING CAMERA" : ["denied", "unavailable", "error"].includes(camera) ? "CAMERA UNAVAILABLE" : "CAMERA OFF";
  return (
    <div className="status-strip">
      <span className={`live-pill ${connection === "connected" ? "is-live" : ""}`}><i /> {connection === "connected" ? "LIVE" : "STANDBY"}</span>
      <span>{labels[connection]}</span>
      <span className="status-divider" />
      <span>{cameraLabel}</span>
    </div>
  );
}
