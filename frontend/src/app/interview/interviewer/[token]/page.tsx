"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { getJson, postForm, postJson } from "@/lib/api";
import WebRTCRoom, { type WebRTCApi } from "@/components/WebRTCRoom";
import type { FacialAffectAnalysis, InterviewSession, LiveSignalEvent, SignalType, VoiceToneAnalysis } from "@/lib/types";

interface SentimentSample {
  session_offset_ms: number;
  facial_affect: FacialAffectAnalysis | null;
  voice_tone: VoiceToneAnalysis | null;
}

const SIGNAL_LABELS: Record<SignalType, string> = {
  tab_switch: "Tab switch",
  window_blur: "Window lost focus",
  copy_paste: "Copy/paste",
  second_face: "Second face detected",
  second_voice: "Second voice detected",
  voice_mismatch: "Voice mismatch detected",
  gaze_off_screen: "Gaze off-screen",
  excessive_motion: "Excessive motion",
  virtual_camera: "Virtual camera signature",
  response_timing_anomaly: "Response timing anomaly",
  unauthorized_app_detected: "Unauthorized app running",
  external_display_detected: "External display connected",
  fullscreen_exit: "Exited fullscreen",
  devtools_open: "Browser DevTools possibly open",
  screen_share_partial: "Shared a tab/window, not full screen",
  screen_share_stopped: "Stopped screen sharing",
  location_mismatch: "IP location doesn't match stated location",
};

const DECISION_OPTIONS: { value: "proceed" | "concern" | "reject"; label: string; className: string }[] = [
  { value: "proceed", label: "Proceed", className: "btn-outline" },
  { value: "concern", label: "Some concern", className: "btn-outline" },
  { value: "reject", label: "Reject", className: "btn-danger-outline" },
];

function formatOffset(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError") {
    return (
      "Microphone access was blocked. Check the browser's permission prompt and your " +
      "computer's system-level privacy settings, then reload this page."
    );
  }
  if (name === "NotFoundError") {
    return "No microphone was found on this device.";
  }
  return "Couldn't access your microphone. Please check permissions and try again.";
}

export default function InterviewerCapturePage() {
  const { token } = useParams<{ token: string }>();
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [liveSignals, setLiveSignals] = useState<LiveSignalEvent[]>([]);
  const [sentimentSamples, setSentimentSamples] = useState<SentimentSample[]>([]);
  const [decision, setDecision] = useState<"proceed" | "concern" | "reject" | null>(null);
  const [decisionNotes, setDecisionNotes] = useState("");
  const [savingDecision, setSavingDecision] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const webrtcApiRef = useRef<WebRTCApi | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [muteRequestSent, setMuteRequestSent] = useState(false);
  // Unmounting WebRTCRoom below is what actually ends the call and releases the camera/mic
  // it uses — there's no separate "hang up" button the way Jitsi's own toolbar had one.
  const [callEnded, setCallEnded] = useState(false);

  useEffect(() => {
    getJson<InterviewSession>(`/interviews/interviewer-join/${token}`)
      .then(setSession)
      .catch(() => setError("This interviewer link is invalid or has expired."));
  }, [token]);

  // Live integrity feed — polled while recording, so the interviewer sees signals as they
  // happen instead of only finding out during post-interview review.
  useEffect(() => {
    if (!recording || !session) return;
    const poll = () =>
      getJson<LiveSignalEvent[]>(`/interviews/${session.id}/live-signals`, {
        "X-Interviewer-Token": session.interviewer_join_token ?? "",
      })
        .then(setLiveSignals)
        .catch(() => {});
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [recording, session]);

  // Live sentiment — updates roughly every 60s (matches the candidate page's sampling
  // cadence), each reading from an independent short clip, never the candidate's live face.
  useEffect(() => {
    if (!recording || !session) return;
    const poll = () =>
      getJson<SentimentSample[]>(`/interviews/${session.id}/live-sentiment`, {
        "X-Interviewer-Token": session.interviewer_join_token ?? "",
      })
        .then(setSentimentSamples)
        .catch(() => {});
    poll();
    const interval = setInterval(poll, 15000);
    return () => clearInterval(interval);
  }, [recording, session]);

  async function startRecording() {
    if (!session) return;
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      recorder.ondataavailable = async (e) => {
        if (e.data.size === 0) return;
        const form = new FormData();
        form.append("chunk", e.data, "chunk.webm");
        await postForm(`/interviews/${session.id}/interviewer-recording-chunk`, form, {
          "X-Interviewer-Token": session.interviewer_join_token ?? "",
        });
      };
      recorder.start(5000);
      recorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      setMicError(cameraErrorMessage(err));
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setRecording(false);
    setStopped(true);
    setCallEnded(true);
  }

  function toggleMic() {
    setMicMuted(webrtcApiRef.current?.toggleMic() ?? false);
  }
  function toggleCamera() {
    setCameraOff(webrtcApiRef.current?.toggleCamera() ?? false);
  }
  // A raw 2-party call has no server in the media path, so there's no way to force the
  // candidate's mic off remotely the way Jitsi's moderator role did — this sends a request
  // over the signaling channel instead; the candidate's page shows it as a dismissible
  // prompt, not a forced action.
  function requestMute() {
    webrtcApiRef.current?.requestPeerMute();
    setMuteRequestSent(true);
    setTimeout(() => setMuteRequestSent(false), 3000);
  }

  async function submitDecision(value: "proceed" | "concern" | "reject") {
    if (!session) return;
    setDecision(value);
    setSavingDecision(true);
    try {
      await postJson(
        `/interviews/${session.id}/interviewer-decision`,
        { decision: value, notes: decisionNotes || null },
        { "X-Interviewer-Token": session.interviewer_join_token ?? "" }
      );
    } finally {
      setSavingDecision(false);
    }
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="max-w-md text-center text-zinc-600">{error}</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <p className="text-zinc-500">Loading…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-8">
      <div className="max-w-2xl w-full space-y-4 text-center">
        <h1 className="text-lg font-semibold">Interviewer</h1>
        <p className="text-sm text-zinc-600">
          You&apos;re conducting the interview for <strong>{session.candidate_name}</strong> —
          join the call below to talk to and see them. Once you&apos;re ready to begin, click
          Start recording — that captures only your side of the conversation, so questions
          and answers can be cross-checked afterward.
        </p>

        {callEnded ? (
          <p className="text-sm text-zinc-600">Call ended.</p>
        ) : (
          <>
            <div className="w-full h-[420px]">
              <WebRTCRoom
                sessionId={session.id}
                token={session.interviewer_join_token ?? ""}
                role="interviewer"
                iceServers={session.ice_servers}
                onApiReady={(api) => {
                  webrtcApiRef.current = api;
                }}
                livekitToken={session.livekit_token}
                livekitUrl={session.livekit_url}
              />
            </div>

            <div className="flex gap-2 justify-center">
              <button onClick={toggleMic} className="btn-outline text-xs px-2 py-1">
                {micMuted ? "Unmute mic" : "Mute mic"}
              </button>
              <button onClick={toggleCamera} className="btn-outline text-xs px-2 py-1">
                {cameraOff ? "Turn camera on" : "Turn camera off"}
              </button>
              <button onClick={requestMute} className="btn-outline text-xs px-2 py-1">
                {muteRequestSent ? "Request sent" : "Ask candidate to mute"}
              </button>
              <button onClick={() => setCallEnded(true)} className="btn-danger-outline text-xs px-2 py-1">
                End call
              </button>
            </div>
          </>
        )}

        <div className="text-left border border-zinc-200 rounded-md p-3 space-y-2">
          <h2 className="text-sm font-medium text-zinc-700">Your live read (optional, updatable anytime)</h2>
          <div className="flex gap-2">
            {DECISION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => submitDecision(opt.value)}
                disabled={savingDecision}
                className={`${opt.className} text-xs px-2 py-1 ${decision === opt.value ? "ring-2 ring-blue-400" : ""}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <input
            value={decisionNotes}
            onChange={(e) => setDecisionNotes(e.target.value)}
            onBlur={() => decision && submitDecision(decision)}
            placeholder="Optional notes for the final decision"
            className="text-xs border border-zinc-300 rounded px-2 py-1 w-full"
          />
        </div>

        {micError && <p className="text-sm text-red-600">{micError}</p>}

        {stopped ? (
          <p className="text-sm text-zinc-600">
            Recording stopped and uploaded. You can close this tab.
          </p>
        ) : recording ? (
          <div className="space-y-3">
            <p className="text-sm text-purple-700 font-medium">● Recording…</p>
            <button onClick={stopRecording} className="btn-danger-outline">
              Stop recording
            </button>

            {sentimentSamples.length > 0 && (
              <div className="text-left pt-2 border-t border-zinc-100">
                <h2 className="text-sm font-medium text-zinc-700 mb-1">
                  Live sentiment{" "}
                  <span className="text-xs font-normal text-zinc-500">
                    (supplementary, updates periodically — not scored)
                  </span>
                </h2>
                <p className="text-xs text-zinc-700">
                  {sentimentSamples[0].facial_affect?.face_visible &&
                    `${sentimentSamples[0].facial_affect.overall_affect} · tension: ${sentimentSamples[0].facial_affect.tension_level}`}
                  {sentimentSamples[0].voice_tone &&
                    ` · voice: ${sentimentSamples[0].voice_tone.overall_tone}`}
                </p>
              </div>
            )}

            <div className="text-left pt-2">
              <h2 className="text-sm font-medium text-zinc-700 mb-2">
                Live integrity signals
              </h2>
              {liveSignals.length === 0 ? (
                <p className="text-xs text-zinc-500">Nothing detected yet.</p>
              ) : (
                <ul className="space-y-1 max-h-48 overflow-y-auto">
                  {liveSignals
                    .slice()
                    .reverse()
                    .map((s, i) => (
                      <li
                        key={i}
                        className="text-xs text-zinc-700 border border-zinc-200 rounded px-2 py-1"
                      >
                        <span className="text-zinc-400">{formatOffset(s.session_offset_ms)}</span>{" "}
                        {SIGNAL_LABELS[s.signal_type]}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <button onClick={startRecording} className="btn-primary">
            Start recording
          </button>
        )}
      </div>
    </div>
  );
}
