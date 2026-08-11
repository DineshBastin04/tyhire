"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { BASE_URL } from "@/lib/api";
import type { IceServer } from "@/lib/types";
import { LiveKitRoom, RoomAudioRenderer, useTracks, VideoTrack } from "@livekit/components-react";
import { Track, Room, RoomEvent } from "livekit-client";
import EyeTrackingOverlay from "@/components/EyeTrackingOverlay";

export interface WebRTCApi {
  /** Toggles the local mic; returns the new muted state. */
  toggleMic: () => boolean;
  /** Toggles the local camera; returns the new camera-off state. */
  toggleCamera: () => boolean;
  /** Interviewer-only: asks the candidate's page to mute itself. There's no way to force
   * it — a raw 2-party connection has no server in the media path that could enforce a
   * mute the way Jitsi's moderator role did — so this is a polite request, not a command. */
  requestPeerMute: () => void;
  /** Tells the other participant's page the call is over from this end — sent explicitly
   * because stopping local media here doesn't by itself close the peer's connection or
   * signaling socket, so without this the other side would just sit on a frozen call with
   * no idea it's over. See onPeerEnded for the receiving side. */
  notifyPeerEnded: () => void;
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
  token: string;
  role: "candidate" | "interviewer";
  iceServers: IceServer[] | null;
  extraVideoTrack?: MediaStreamTrack | null;
  onApiReady?: (api: WebRTCApi) => void;
  onMuteRequested?: () => void;
  /** Fired when the other participant ends the call — either explicitly (they clicked
   * their own end/finish button) or because their connection dropped (tab closed, crashed,
   * network gone). Callers should react the same way they'd react to their own local
   * end/finish action, so both sides always finalize their recording and wrap up together
   * rather than one side being left on a dead call. */
  onPeerEnded?: () => void;
  onPeerConnectedChange?: (connected: boolean) => void;
  livekitToken?: string | null;
  livekitUrl?: string | null;
  enableEyeTracking?: boolean;
  onGazeChange?: (isFocused: boolean, isTeleprompter?: boolean) => void;
}

function wsBaseUrl(): string {
  if (BASE_URL.startsWith("http")) return BASE_URL.replace(/^http/, "ws");
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  
  // In local development, the Next.js dev server (port 3000) does not proxy WebSocket upgrades.
  // Bypass it and connect directly to the FastAPI backend running on port 8000.
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return `${proto}//${window.location.hostname}:8000${BASE_URL}`;
  }
  
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
  onPeerEnded,
  onPeerConnectedChange,
  livekitToken,
  livekitUrl,
  enableEyeTracking = false,
  onGazeChange,
}: WebRTCRoomProps) {
  if (livekitToken && livekitUrl) {
    return (
      <LiveKitRoomRenderer
        sessionId={sessionId}
        token={livekitToken}
        role={role}
        url={livekitUrl}
        extraVideoTrack={extraVideoTrack}
        onApiReady={onApiReady}
        onMuteRequested={onMuteRequested}
        onPeerEnded={onPeerEnded}
        onPeerConnectedChange={onPeerConnectedChange}
      />
    );
  }

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
      localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640, max: 1280 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 15, max: 24 }
        },
        audio: true
      });
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
        notifyPeerEnded: () => send({ type: "call-ended" }),
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
          // The peer's signaling socket closed — tab closed, crashed, or network gone. A
          // real disconnect only ever fires this once (no flapping/reconnect logic on
          // either side), so treating it as "the call is over" here is safe, and it's the
          // only signal at all for a peer who closed their tab before explicitly ending.
          onPeerEnded?.();
        } else if (message.type === "call-ended") {
          // Sent explicitly when the peer ends the call but stays on their page (e.g. to
          // view a post-call scorecard) — their socket is still open, so "peer-left" above
          // won't fire on its own.
          onPeerEnded?.();
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

  const [isGazeFocused, setIsGazeFocused] = useState(true);
  const [isTeleprompter, setIsTeleprompter] = useState(false);

  const handleGaze = (focused: boolean, teleprompter?: boolean) => {
    setIsGazeFocused(focused);
    if (teleprompter !== undefined) setIsTeleprompter(teleprompter);
    onGazeChange?.(focused, teleprompter);
  };

  // Interviewer Dynamic Gaze Border Class
  const gazeBorderClass = isTeleprompter
    ? "border-purple-500 ring-4 ring-purple-500/40 shadow-[0_0_20px_rgba(168,85,247,0.5)]"
    : isGazeFocused
    ? "border-emerald-500 ring-2 ring-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.3)]"
    : "border-red-500 ring-4 ring-red-500/40 shadow-[0_0_20px_rgba(239,68,68,0.5)] animate-pulse";

  if (role === "interviewer") {
    return (
      <div className="relative w-full h-full min-h-[380px] flex flex-col md:flex-row gap-3">
        {/* Candidate Screenshare Viewport */}
        <div className="relative flex-1 min-h-[220px] bg-zinc-950 rounded-xl overflow-hidden border border-zinc-200 flex flex-col items-center justify-center">
          {hasRemoteScreen ? (
            <>
              <video
                ref={remoteScreenRef}
                autoPlay
                playsInline
                className="w-full h-full object-contain bg-zinc-950"
              />
              <div className="absolute top-2 left-2 px-2.5 py-1 rounded-md bg-white/90 shadow text-xs font-semibold text-zinc-800 border border-zinc-200 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
                <span>🖥️ Candidate Screenshare (Live)</span>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center p-6 text-center text-zinc-400">
              <span className="text-3xl mb-2">🖥️</span>
              <p className="text-xs font-medium">Candidate Screen Share</p>
              <p className="text-[11px] text-zinc-500 mt-0.5">Waiting for candidate to start screen share…</p>
            </div>
          )}
        </div>

        {/* Candidate Live Camera with Gaze Border */}
        <div
          className={`relative w-full md:w-80 min-h-[220px] bg-zinc-900 rounded-xl overflow-hidden border-2 transition-all duration-300 ${gazeBorderClass}`}
        >
          {!peerPresent && (
            <p className="absolute inset-0 flex items-center justify-center text-xs text-white/60">
              Waiting for candidate to join…
            </p>
          )}
          <video
            ref={remoteVideoRef}
            autoPlay
            playsInline
            className="w-full h-full object-cover"
          />
          {enableEyeTracking && (
            <EyeTrackingOverlay videoRef={remoteVideoRef} onGazeChange={handleGaze} />
          )}

          {/* Gaze Status HUD Badge on Camera */}
          <div className="absolute top-2 left-2 px-2.5 py-1 rounded-full text-xs font-bold bg-white/95 shadow-md border border-zinc-200 flex items-center gap-1.5 z-10">
            <span
              className={`w-2 h-2 rounded-full ${
                isTeleprompter
                  ? "bg-purple-600 animate-pulse"
                  : isGazeFocused
                  ? "bg-emerald-500"
                  : "bg-red-500 animate-pulse"
              }`}
            />
            <span
              className={
                isTeleprompter
                  ? "text-purple-700 font-bold"
                  : isGazeFocused
                  ? "text-emerald-700"
                  : "text-red-600 font-bold"
              }
            >
              {isTeleprompter
                ? "⚠️ Teleprompter Reading"
                : isGazeFocused
                ? "🟢 Gaze: Focused"
                : "🔴 Gaze: Looking Away"}
            </span>
          </div>

          {/* Interviewer Self-PIP */}
          <div className="absolute bottom-2 right-2 w-24 h-16 rounded-lg overflow-hidden border border-white/40 shadow-md bg-black">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full min-h-[360px] rounded-xl bg-black overflow-hidden border border-zinc-200">
      {!peerPresent && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-white/60">
          Waiting for interviewer to join…
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
      <div className="absolute bottom-2 right-2 w-28 h-20 rounded-lg overflow-hidden border border-white/40 shadow bg-black">
        <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
      </div>
    </div>
  );
}

function LiveKitRoomRenderer({
  sessionId,
  token,
  role,
  url,
  extraVideoTrack,
  onApiReady,
  onMuteRequested,
  onPeerEnded,
  onPeerConnectedChange,
}: {
  sessionId: string;
  token: string;
  role: "candidate" | "interviewer";
  url: string;
  extraVideoTrack?: MediaStreamTrack | null;
  onApiReady?: (api: WebRTCApi) => void;
  onMuteRequested?: () => void;
  onPeerEnded?: () => void;
  onPeerConnectedChange?: (connected: boolean) => void;
}) {
  const room = useMemo(() => new Room(), []);

  const cameraTracks = useTracks([Track.Source.Camera]);
  const screenTracks = useTracks([Track.Source.ScreenShare]);

  const localCamera = cameraTracks.find((t) => t.participant.isLocal);
  const remoteCamera = cameraTracks.find((t) => !t.participant.isLocal);
  const remoteScreen = screenTracks.find((t) => !t.participant.isLocal);

  const peerPresent = cameraTracks.length > 1;

  useEffect(() => {
    onPeerConnectedChange?.(peerPresent);
  }, [peerPresent, onPeerConnectedChange]);

  // Publish screen-share track if available and room is connected
  useEffect(() => {
    if (extraVideoTrack && room.state === "connected") {
      room.localParticipant.publishTrack(extraVideoTrack).catch((err) => {
        console.error("failed to publish extra video track", err);
      });
    }
  }, [extraVideoTrack, room, room.state]);

  useEffect(() => {
    if (onApiReady) {
      onApiReady({
        toggleMic: () => {
          const isEnabled = room.localParticipant.isMicrophoneEnabled;
          room.localParticipant.setMicrophoneEnabled(!isEnabled);
          return isEnabled;
        },
        toggleCamera: () => {
          const isEnabled = room.localParticipant.isCameraEnabled;
          room.localParticipant.setCameraEnabled(!isEnabled);
          return isEnabled;
        },
        requestPeerMute: () => {
          const encoder = new TextEncoder();
          room.localParticipant.publishData(
            encoder.encode(JSON.stringify({ type: "mute-request" })),
            { reliable: true }
          ).catch((err) => console.error("failed to publish data", err));
        },
        notifyPeerEnded: () => {
          const encoder = new TextEncoder();
          room.localParticipant.publishData(
            encoder.encode(JSON.stringify({ type: "call-ended" })),
            { reliable: true }
          ).catch((err) => console.error("failed to publish data", err));
        },
      });
    }
  }, [onApiReady, room]);

  useEffect(() => {
    const handleData = (payload: Uint8Array) => {
      try {
        const decoder = new TextDecoder();
        const msg = JSON.parse(decoder.decode(payload));
        if (msg.type === "mute-request") {
          onMuteRequested?.();
        } else if (msg.type === "call-ended") {
          // Peer ended but is still connected to the room (e.g. reviewing a post-call
          // scorecard) — RoomEvent.ParticipantDisconnected below won't fire on its own yet.
          onPeerEnded?.();
        }
      } catch (err) {
        console.error("failed to parse LiveKit data message", err);
      }
    };

    // Backstop for a peer who closes their tab without explicitly ending first — LiveKit
    // fires this once, server-detected, the same way the raw-WebRTC path's "peer-left"
    // does, so it's safe to treat as "the call is over" here too.
    const handleParticipantDisconnected = () => onPeerEnded?.();

    room.on("dataReceived", handleData);
    room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
    return () => {
      room.off("dataReceived", handleData);
      room.off(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
    };
  }, [onMuteRequested, onPeerEnded, room]);

  return (
    <LiveKitRoom
      room={room}
      serverUrl={url}
      token={token}
      connect={true}
      video={true}
      audio={true}
      className="relative w-full h-full min-h-[360px] rounded-md bg-black overflow-hidden"
    >
      <RoomAudioRenderer />
      {!peerPresent && (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-white/60">
          Waiting for the other participant to join…
        </p>
      )}

      {remoteCamera && (
        <VideoTrack
          trackRef={remoteCamera}
          className="w-full h-full object-contain"
        />
      )}

      {remoteScreen && (
        <VideoTrack
          trackRef={remoteScreen}
          className="absolute inset-0 w-full h-full object-contain bg-black"
        />
      )}

      {localCamera && (
        <VideoTrack
          trackRef={localCamera}
          className="absolute bottom-2 right-2 w-28 h-20 rounded border border-white/30 object-cover"
        />
      )}
    </LiveKitRoom>
  );
}
