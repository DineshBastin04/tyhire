"use client";

import { useEffect, useRef, useState } from "react";
import { BASE_URL } from "@/lib/api";
import type { IceServer } from "@/lib/types";

export interface WebRTCApi {
  /** Toggles the local mic; returns the new muted state. */
  toggleMic: () => boolean;
  /** Toggles the local camera; returns the new camera-off state. */
  toggleCamera: () => boolean;
  /** Interviewer-only: asks the candidate's page to mute itself. There's no way to force
   * it — a raw 2-party connection has no server in the media path that could enforce a
   * mute the way Jitsi's moderator role did — so this is a polite request, not a command. */
  requestPeerMute: () => void;
}

/**
 * Requests camera/mic and opens the signaling connection as soon as this component
 * mounts — there is no internal "idle until told" gate. Both call sites (the candidate
 * and interviewer pages) rely on that: they show their own explicit "Join Meet" button
 * first and only render this component once it's clicked, rather than mounting it
 * immediately on page load. Don't render this behind a route/stage that isn't itself
 * gated on an explicit user action, or camera/mic + the call will start without consent.
 */
interface WebRTCRoomProps {
  sessionId: string;
  /** join_token or interviewer_join_token, matching `role`. */
  token: string;
  role: "candidate" | "interviewer";
  iceServers: IceServer[] | null;
  /** Already-captured screen-share track (if any), added in the same batch as the
   * camera/mic tracks so the connection only negotiates once. Adding it via a separate
   * renegotiation a moment later — even just a tick later — is what caused Chrome's
   * "BUNDLE group codec collision" error: two back-to-back renegotiations each adding a
   * new video m-line confuses its header-extension-id assignment. */
  extraVideoTrack?: MediaStreamTrack | null;
  onApiReady?: (api: WebRTCApi) => void;
  /** Fired on the candidate's side when the interviewer clicks "request mute". */
  onMuteRequested?: () => void;
  onPeerConnectedChange?: (connected: boolean) => void;
}

function wsBaseUrl(): string {
  if (BASE_URL.startsWith("http")) return BASE_URL.replace(/^http/, "ws");
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${BASE_URL}`;
}

const DEFAULT_ICE_SERVERS: IceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export default function WebRTCRoom({
  sessionId,
  token,
  role,
  iceServers,
  extraVideoTrack,
  onApiReady,
  onMuteRequested,
  onPeerConnectedChange,
}: WebRTCRoomProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteScreenRef = useRef<HTMLVideoElement>(null);
  const pendingScreenStreamRef = useRef<MediaStream | null>(null);
  const [hasRemoteScreen, setHasRemoteScreen] = useState(false);
  const [peerPresent, setPeerPresent] = useState(false);
  // Read via ref inside the connection effect below so passing a new track object doesn't
  // need to (and shouldn't) tear down and rebuild the whole peer connection. The write
  // itself has to happen in its own effect, not directly in the render body — mutating a
  // ref during render is unsound (react-hooks/refs): render isn't guaranteed to run
  // exactly once per commit (Strict Mode's double-invoke, future concurrent rendering),
  // so a direct write here could apply more than once or be visible before the value it's
  // based on is actually committed.
  const extraVideoTrackRef = useRef<MediaStreamTrack | null | undefined>(extraVideoTrack);
  useEffect(() => {
    extraVideoTrackRef.current = extraVideoTrack;
  }, [extraVideoTrack]);

  // The screen-share <video> only renders once hasRemoteScreen flips true, so on the very
  // first screen-share track the ref isn't attached yet when ontrack fires — stash the
  // stream and apply it here once the element exists.
  useEffect(() => {
    if (hasRemoteScreen && remoteScreenRef.current && pendingScreenStreamRef.current) {
      remoteScreenRef.current.srcObject = pendingScreenStreamRef.current;
    }
  }, [hasRemoteScreen]);

  useEffect(() => {
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let ws: WebSocket | null = null;
    let localStream: MediaStream | null = null;
    let remoteCameraStreamId: string | null = null;

    // "Perfect negotiation" (MDN's recommended pattern): one side is designated polite so
    // that if both sides happen to send an offer at once, there's a deterministic way to
    // resolve it instead of the connection getting stuck. Arbitrary but fixed choice.
    const polite = role === "candidate";
    let makingOffer = false;
    let ignoreOffer = false;
    let tracksAdded = false;

    function send(message: Record<string, unknown>) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    }

    async function start() {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (cancelled) {
        localStream.getTracks().forEach((t) => t.stop());
        return;
      }
      if (localVideoRef.current) localVideoRef.current.srcObject = localStream;

      pc = new RTCPeerConnection({
        iceServers: (iceServers && iceServers.length > 0 ? iceServers : DEFAULT_ICE_SERVERS).map(
          (s) => ({ urls: s.urls, username: s.username, credential: s.credential })
        ),
      });

      // Tracks are added only once we know the peer is actually in the room (see the
      // "peer-joined" handling below), not immediately here. addTrack() is what triggers
      // onnegotiationneeded/the first offer — doing that before the signaling socket below
      // has even finished connecting meant that first offer had nowhere to go and was
      // silently lost, permanently stalling the connection with nothing to ever retry it.
      function addLocalTracks() {
        if (tracksAdded || !pc || !localStream) return;
        tracksAdded = true;
        // All added synchronously in one batch (camera, mic, and — if already captured —
        // screen) so the browser negotiates once, not across separate back-to-back
        // renegotiations (see extraVideoTrack's doc comment on the collision that caused).
        localStream.getTracks().forEach((track) => pc!.addTrack(track, localStream!));
        if (extraVideoTrackRef.current) {
          pc.addTrack(extraVideoTrackRef.current, new MediaStream([extraVideoTrackRef.current]));
        }
      }

      pc.onnegotiationneeded = async () => {
        try {
          makingOffer = true;
          await pc!.setLocalDescription();
          send({ type: pc!.localDescription!.type, sdp: pc!.localDescription!.sdp });
        } catch (err) {
          console.error("negotiation failed", err);
        } finally {
          makingOffer = false;
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) send({ type: "ice-candidate", candidate: candidate.toJSON() });
      };

      pc.onconnectionstatechange = () => {
        onPeerConnectedChange?.(pc?.connectionState === "connected");
      };

      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (!stream) return;
        if (!remoteCameraStreamId) remoteCameraStreamId = stream.id;
        const isScreen = stream.id !== remoteCameraStreamId;
        if (isScreen) {
          pendingScreenStreamRef.current = stream;
          if (remoteScreenRef.current) remoteScreenRef.current.srcObject = stream;
          setHasRemoteScreen(true);
        } else if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== stream) {
          remoteVideoRef.current.srcObject = stream;
        }
      };

      onApiReady?.({
        toggleMic: () => {
          const track = localStream?.getAudioTracks()[0];
          if (!track) return false;
          track.enabled = !track.enabled;
          return !track.enabled;
        },
        toggleCamera: () => {
          const track = localStream?.getVideoTracks()[0];
          if (!track) return false;
          track.enabled = !track.enabled;
          return !track.enabled;
        },
        requestPeerMute: () => send({ type: "mute-request" }),
      });

      const wsUrl = `${wsBaseUrl()}/interviews/${sessionId}/ws/signal?token=${encodeURIComponent(
        token
      )}&role=${role}`;
      ws = new WebSocket(wsUrl);
      ws.onmessage = async (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "peer-joined") {
          setPeerPresent(true);
          addLocalTracks();
        } else if (message.type === "peer-left") {
          setPeerPresent(false);
          onPeerConnectedChange?.(false);
          if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
          if (remoteScreenRef.current) remoteScreenRef.current.srcObject = null;
          pendingScreenStreamRef.current = null;
          remoteCameraStreamId = null;
          setHasRemoteScreen(false);
        } else if (message.type === "offer" || message.type === "answer") {
          const description = { type: message.type, sdp: message.sdp } as RTCSessionDescriptionInit;
          const offerCollision =
            message.type === "offer" && (makingOffer || pc!.signalingState !== "stable");
          ignoreOffer = !polite && offerCollision;
          if (ignoreOffer) return;
          await pc!.setRemoteDescription(description);
          if (message.type === "offer") {
            await pc!.setLocalDescription();
            send({ type: pc!.localDescription!.type, sdp: pc!.localDescription!.sdp });
          }
        } else if (message.type === "ice-candidate" && message.candidate) {
          try {
            await pc!.addIceCandidate(message.candidate);
          } catch (err) {
            if (!ignoreOffer) console.error("failed to add ICE candidate", err);
          }
        } else if (message.type === "mute-request") {
          onMuteRequested?.();
        }
      };
    }

    start().catch((err) => console.error("Couldn't start the call", err));

    return () => {
      cancelled = true;
      ws?.close();
      pc?.close();
      localStream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, token, role]);

  return (
    <div className="relative w-full h-full min-h-[360px] rounded-md bg-black overflow-hidden">
      {!peerPresent && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-white/60">
          Waiting for the other participant to join…
        </p>
      )}
      <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-contain" />
      {hasRemoteScreen && (
        <video
          ref={remoteScreenRef}
          autoPlay
          playsInline
          className="absolute inset-0 w-full h-full object-contain bg-black"
        />
      )}
      <video
        ref={localVideoRef}
        autoPlay
        playsInline
        muted
        className="absolute bottom-2 right-2 w-28 h-20 rounded border border-white/30 object-cover"
      />
    </div>
  );
}
