"use client";

import { useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { RTC_CONFIGURATION } from "@/lib/rtcConfig";
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
  | "error";

export function useWebRTC(
  roomId: string,
  role: RoomRole,
  localStream: MediaStream | null,
) {
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("waiting");
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

  useEffect(() => {
    if (!localStream) return;

    const socket = createSignalingSocket();
    socketRef.current = socket;
    let active = true;

    const closePeer = () => {
      peerRef.current?.close();
      peerRef.current = null;
      pendingCandidatesRef.current = [];
      setRemoteStream(null);
    };

    const createPeer = () => {
      if (peerRef.current) return peerRef.current;
      const peer = new RTCPeerConnection(RTC_CONFIGURATION);
      peerRef.current = peer;
      localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));

      peer.onicecandidate = ({ candidate }) => {
        if (candidate) socket.emit("ice-candidate", candidate.toJSON());
      };
      peer.ontrack = ({ streams }) => {
        if (streams[0]) setRemoteStream(streams[0]);
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "connected") setConnectionState("connected");
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
          setConnectionState("disconnected");
        }
      };
      return peer;
    };

    const flushCandidates = async (peer: RTCPeerConnection) => {
      for (const candidate of pendingCandidatesRef.current) {
        await peer.addIceCandidate(candidate);
      }
      pendingCandidatesRef.current = [];
    };

    socket.on("connect", () => {
      const eventName = role === "host" ? "create-room" : "join-room";
      socket.emit(
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

    socket.on("peer-joined", async () => {
      setConnectionState("connecting");
      const peer = createPeer();
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      socket.emit("webrtc-offer", offer);
    });

    socket.on("webrtc-offer", async (offer: RTCSessionDescriptionInit) => {
      setConnectionState("connecting");
      const peer = createPeer();
      await peer.setRemoteDescription(offer);
      await flushCandidates(peer);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      socket.emit("webrtc-answer", answer);
    });

    socket.on("webrtc-answer", async (answer: RTCSessionDescriptionInit) => {
      const peer = peerRef.current;
      if (!peer) return;
      await peer.setRemoteDescription(answer);
      await flushCandidates(peer);
    });

    socket.on("ice-candidate", async (candidate: RTCIceCandidateInit) => {
      const peer = peerRef.current;
      if (!peer?.remoteDescription) {
        pendingCandidatesRef.current.push(candidate);
        return;
      }
      await peer.addIceCandidate(candidate);
    });

    socket.on("peer-left", () => {
      closePeer();
      setConnectionState("disconnected");
    });
    socket.on("connect_error", () => {
      setError("Could not reach the signalling server.");
      setConnectionState("error");
    });

    return () => {
      active = false;
      socket.emit("leave-room");
      socket.disconnect();
      closePeer();
      socketRef.current = null;
    };
  }, [localStream, role, roomId]);

  return { remoteStream, connectionState, error };
}
