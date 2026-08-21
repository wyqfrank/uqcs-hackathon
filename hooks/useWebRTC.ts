"use client";

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { readActiveRoute } from "@/lib/iceStats";
import {
  getIceConfig,
  type IceCandidateType,
  type IceRoute,
  type TurnSource,
} from "@/lib/rtcConfig";
import {
  createSignalingSocket,
  type RoomAcknowledgement,
  type RoomRole,
} from "@/lib/signaling";

export type ConnectionState =
  | "waiting"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "error";

const ROUTE_POLL_MS = 2000;

export function useWebRTC(
  roomId: string,
  role: RoomRole,
  localStream: MediaStream | null,
) {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("waiting");
  const [candidateTypes, setCandidateTypes] = useState<IceCandidateType[]>([]);
  const [route, setRoute] = useState<IceRoute | null>(null);
  const [turnSource, setTurnSource] = useState<TurnSource>("none");
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const routeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!localStream) return;

    let active = true;
    let socket: Socket | null = null;

    const stopRoutePolling = () => {
      if (routeTimerRef.current) clearInterval(routeTimerRef.current);
      routeTimerRef.current = null;
    };

    const closePeer = () => {
      stopRoutePolling();
      peerRef.current?.close();
      peerRef.current = null;
      pendingCandidatesRef.current = [];
      setRemoteStream(null);
      setRoute(null);
      setCandidateTypes([]);
    };

    const startRoutePolling = (peer: RTCPeerConnection) => {
      if (routeTimerRef.current) return;
      const sample = async () => {
        if (peerRef.current !== peer) return;
        const nextRoute = await readActiveRoute(peer);
        if (active && peerRef.current === peer) setRoute(nextRoute);
      };
      void sample();
      routeTimerRef.current = setInterval(() => void sample(), ROUTE_POLL_MS);
    };

    const start = async () => {
      // Cloudflare mints TURN credentials on demand, so the configuration has to
      // resolve before the first RTCPeerConnection exists. Signalling waits on it
      // too: an offer built without the relay could not fall back to it later.
      const { configuration, turnSource: resolvedTurnSource } = await getIceConfig();
      if (!active) return;
      setTurnSource(resolvedTurnSource);

      const activeSocket = createSignalingSocket();
      socket = activeSocket;
      socketRef.current = activeSocket;

      const flushCandidates = async (peer: RTCPeerConnection) => {
        for (const candidate of pendingCandidatesRef.current) {
          await peer.addIceCandidate(candidate);
        }
        pendingCandidatesRef.current = [];
      };

      const createPeer = () => {
        if (peerRef.current) return peerRef.current;
        const peer = new RTCPeerConnection(configuration);
        peerRef.current = peer;
        localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));

        peer.onicecandidate = ({ candidate }) => {
          if (!candidate) return;
          if (candidate.type) {
            const type = candidate.type as IceCandidateType;
            setCandidateTypes((current) =>
              current.includes(type) ? current : [...current, type],
            );
          }
          activeSocket.emit("ice-candidate", candidate.toJSON());
        };
        peer.ontrack = ({ streams }) => {
          if (streams[0]) setRemoteStream(streams[0]);
        };
        peer.onconnectionstatechange = () => {
          if (peer.connectionState === "connected") {
            setConnectionState("connected");
            setError(null);
            startRoutePolling(peer);
            return;
          }
          // "failed" means ICE exhausted every candidate pair — a network problem,
          // not a peer that walked away. Keep the two distinguishable in the UI.
          if (peer.connectionState === "failed") {
            stopRoutePolling();
            setConnectionState("failed");
            setError(
              resolvedTurnSource === "none"
                ? "No video route exists on this network and no TURN relay is configured. Run the network check, or move both laptops onto a phone hotspot."
                : "No video route exists on this network, even through the TURN relay. Run the network check for details.",
            );
            return;
          }
          if (["disconnected", "closed"].includes(peer.connectionState)) {
            stopRoutePolling();
            setConnectionState("disconnected");
          }
        };
        return peer;
      };

      activeSocket.on("connect", () => {
        const eventName = role === "host" ? "create-room" : "join-room";
        activeSocket.emit(
          eventName,
          { roomId },
          (acknowledgement: RoomAcknowledgement) => {
            if (!active) return;
            if (!acknowledgement.ok) {
              setError(acknowledgement.error);
              setConnectionState("error");
              return;
            }
            setConnectionState("waiting");
          },
        );
      });

      activeSocket.on("peer-joined", async () => {
        setConnectionState("connecting");
        const peer = createPeer();
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        activeSocket.emit("webrtc-offer", offer);
      });

      activeSocket.on("webrtc-offer", async (offer: RTCSessionDescriptionInit) => {
        setConnectionState("connecting");
        const peer = createPeer();
        await peer.setRemoteDescription(offer);
        await flushCandidates(peer);
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        activeSocket.emit("webrtc-answer", answer);
      });

      activeSocket.on("webrtc-answer", async (answer: RTCSessionDescriptionInit) => {
        const peer = peerRef.current;
        if (!peer) return;
        await peer.setRemoteDescription(answer);
        await flushCandidates(peer);
      });

      activeSocket.on("ice-candidate", async (candidate: RTCIceCandidateInit) => {
        const peer = peerRef.current;
        if (!peer?.remoteDescription) {
          pendingCandidatesRef.current.push(candidate);
          return;
        }
        await peer.addIceCandidate(candidate);
      });

      activeSocket.on("peer-left", () => {
        closePeer();
        setConnectionState("disconnected");
      });
      activeSocket.on("connect_error", () => {
        setError("Could not reach the signalling server.");
        setConnectionState("error");
      });
    };

    void start();

    return () => {
      active = false;
      socket?.emit("leave-room");
      socket?.disconnect();
      closePeer();
      socketRef.current = null;
    };
  }, [localStream, role, roomId]);

  return { remoteStream, connectionState, candidateTypes, route, turnSource, error };
}
