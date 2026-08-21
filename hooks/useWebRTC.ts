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
const JOIN_RETRY_MS = 2000;
const JOIN_MAX_ATTEMPTS = 15;

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
  const joinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localStreamRef = useRef<MediaStream | null>(localStream);
  const videoSenderRef = useRef<RTCRtpSender | null>(null);

  // Swapping the outgoing track keeps the peer connection alive across camera
  // stops and restarts. Tearing the connection down and renegotiating would drop
  // the opponent every time someone toggles their camera.
  useEffect(() => {
    localStreamRef.current = localStream;
    const sender = videoSenderRef.current;
    if (!sender) return;
    void sender.replaceTrack(localStream?.getVideoTracks()[0] ?? null);
  }, [localStream]);

  // Signalling deliberately does not depend on the camera. A guest who joins
  // before the host has granted camera access used to be told the battle did not
  // exist; the room is now claimed as soon as the page loads.
  useEffect(() => {
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
      videoSenderRef.current = null;
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
      // resolve before the first RTCPeerConnection exists.
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

      /**
       * Binds the outgoing camera to the connection's video transceiver.
       *
       * The offerer runs this before creating the offer, so there is no
       * transceiver yet and one is added. The answerer must run it *after*
       * setRemoteDescription, so that the transceiver the offer created is
       * reused. Adding one beforehand leaves the answerer with two — it receives
       * on the offer's and sends on an unassociated one that is never
       * negotiated, which shows up as video travelling in one direction only.
       */
      const attachLocalVideo = (peer: RTCPeerConnection) => {
        let transceiver = peer
          .getTransceivers()
          .find((candidate) =>
            [candidate.sender.track?.kind, candidate.receiver.track?.kind].includes("video"),
          );

        if (transceiver) {
          // The offer may have arrived as recvonly if the far side had no camera.
          transceiver.direction = "sendrecv";
        } else {
          transceiver = peer.addTransceiver("video", { direction: "sendrecv" });
        }

        videoSenderRef.current = transceiver.sender;
        void transceiver.sender.replaceTrack(
          localStreamRef.current?.getVideoTracks()[0] ?? null,
        );
      };

      const createPeer = () => {
        if (peerRef.current) return peerRef.current;
        const peer = new RTCPeerConnection(configuration);
        peerRef.current = peer;

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
        peer.ontrack = ({ streams, track: remoteTrack }) => {
          // A transceiver-reserved m-line carries no stream association, so wrap
          // the bare track when the sender did not supply one.
          const stream = streams[0] ?? new MediaStream([remoteTrack]);
          // The reserved m-line yields a track before the opponent has a camera,
          // and it goes muted again whenever they stop it. Following mute state
          // keeps "camera off" from looking like a live feed.
          const syncRemote = () => setRemoteStream(remoteTrack.muted ? null : stream);
          remoteTrack.onunmute = syncRemote;
          remoteTrack.onmute = syncRemote;
          syncRemote();
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

      let joinAttempts = 0;
      const joinRoom = () => {
        if (!active) return;
        const eventName = role === "host" ? "create-room" : "join-room";
        activeSocket.emit(
          eventName,
          { roomId },
          (acknowledgement: RoomAcknowledgement) => {
            if (!active) return;
            if (acknowledgement.ok) {
              joinAttempts = 0;
              setConnectionState("waiting");
              setError(null);
              return;
            }

            // The host may simply not have loaded yet, so a guest retries for a
            // while before calling the code wrong.
            const hostMayStillArrive =
              role === "guest" && acknowledgement.code === "not-found";
            if (hostMayStillArrive && joinAttempts < JOIN_MAX_ATTEMPTS) {
              joinAttempts += 1;
              setConnectionState("waiting");
              joinTimerRef.current = setTimeout(joinRoom, JOIN_RETRY_MS);
              return;
            }

            setError(
              hostMayStillArrive
                ? "No one has started this battle. Check the code, or ask the host to create the battle first."
                : acknowledgement.error,
            );
            setConnectionState("error");
          },
        );
      };

      activeSocket.on("connect", joinRoom);

      activeSocket.on("peer-joined", async () => {
        setConnectionState("connecting");
        const peer = createPeer();
        attachLocalVideo(peer);
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        activeSocket.emit("webrtc-offer", offer);
      });

      activeSocket.on("webrtc-offer", async (offer: RTCSessionDescriptionInit) => {
        setConnectionState("connecting");
        const peer = createPeer();
        await peer.setRemoteDescription(offer);
        // Only now does the offer's transceiver exist to be reused.
        attachLocalVideo(peer);
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
      if (joinTimerRef.current) clearTimeout(joinTimerRef.current);
      joinTimerRef.current = null;
      socket?.emit("leave-room");
      socket?.disconnect();
      closePeer();
      socketRef.current = null;
    };
  }, [role, roomId]);

  return { remoteStream, connectionState, candidateTypes, route, turnSource, error };
}
