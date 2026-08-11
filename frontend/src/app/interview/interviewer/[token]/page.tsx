"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState, useCallback } from "react";
import { BASE_URL, getJson, postForm, postJson } from "@/lib/api";
import WebRTCRoom, { type WebRTCApi } from "@/components/WebRTCRoom";
import LiveTranscriptFeed from "@/components/LiveTranscriptFeed";
import { useLiveSpeech, type LiveTranscriptItem } from "@/lib/useLiveSpeech";
import { exitFullscreen, isFullscreenActive, requestFullscreen } from "@/lib/fullscreen";
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
  gaze_off_screen: "Gaze off-screen (Looking away)",
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
  ai_extension_detected: "AI answer-helper browser extension detected",
};

const DECISION_OPTIONS: { value: "proceed" | "concern" | "reject"; label: string; className: string }[] = [
  { value: "proceed", label: "Proceed", className: "bg-emerald-600 hover:bg-emerald-700 text-white font-medium" },
  { value: "concern", label: "Some concern", className: "bg-amber-600 hover:bg-amber-700 text-white font-medium" },
  { value: "reject", label: "Reject", className: "bg-red-600 hover:bg-red-700 text-white font-medium" },
];

function formatOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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
  const [activeTab, setActiveTab] = useState<"transcript" | "sentiment" | "proctoring" | "evaluation">("transcript");
  const [isCandidateGazeFocused, setIsCandidateGazeFocused] = useState(true);

  // Consolidated scorecard post-meeting state
  const [showScorecard, setShowScorecard] = useState(false);
  const [consolidatedReport, setConsolidatedReport] = useState<Record<string, unknown> | null>(null);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [emailRecipient, setEmailRecipient] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const webrtcApiRef = useRef<WebRTCApi | null>(null);
  const [micMuted, setMicMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [muteRequestSent, setMuteRequestSent] = useState(false);
  const [callEnded, setCallEnded] = useState(false);
  const [joined, setJoined] = useState(false);
  const [callStartTime, setCallStartTime] = useState<number>(Date.now());

  // Live Speech Recognition for interviewer
  const {
    liveItems: interviewerTranscriptItems,
    currentInterim: interviewerInterim,
  } = useLiveSpeech({
    sessionId: session?.id,
    speaker: "interviewer",
    enabled: joined && !callEnded,
    startedAtMs: callStartTime,
    authToken: session?.interviewer_join_token ?? undefined,
    tokenHeaderKey: "X-Interviewer-Token",
  });

  // Polled live transcript items from both candidate & interviewer
  const [mergedLiveTranscripts, setMergedLiveTranscripts] = useState<LiveTranscriptItem[]>([]);

  useEffect(() => {
    getJson<InterviewSession>(`/interviews/interviewer-join/${token}`)
      .then((s) => {
        setSession(s);
        if (s.interviewer_live_decision) setDecision(s.interviewer_live_decision as "proceed" | "concern" | "reject");
        if (s.interviewer_live_notes) setDecisionNotes(s.interviewer_live_notes);
      })
      .catch(() => setError("This interviewer link is invalid or has expired."));
  }, [token]);

  // Live signals polling
  useEffect(() => {
    if (!session || callEnded) return;
    const poll = () =>
      getJson<LiveSignalEvent[]>(`/interviews/${session.id}/live-signals`, {
        "X-Interviewer-Token": session.interviewer_join_token ?? "",
      })
        .then(setLiveSignals)
        .catch(() => {});
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [session, callEnded]);

  // Live sentiment polling
  useEffect(() => {
    if (!session || callEnded) return;
    const poll = () =>
      getJson<SentimentSample[]>(`/interviews/${session.id}/live-sentiment`, {
        "X-Interviewer-Token": session.interviewer_join_token ?? "",
      })
        .then(setSentimentSamples)
        .catch(() => {});
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, [session, callEnded]);

  // Live transcripts polling from backend
  useEffect(() => {
    if (!session || callEnded) return;
    const poll = () =>
      getJson<LiveTranscriptItem[]>(`/interviews/${session.id}/live-transcripts`, {
        "X-Interviewer-Token": session.interviewer_join_token ?? "",
      })
        .then((items) => {
          if (items && items.length > 0) {
            setMergedLiveTranscripts(items);
          }
        })
        .catch(() => {});
    poll();
    const interval = setInterval(poll, 2500);
    return () => clearInterval(interval);
  }, [session, callEnded]);

  // Combine polled transcripts and local interviewer recognition
  const allTranscripts = mergedLiveTranscripts.length > 0
    ? mergedLiveTranscripts
    : interviewerTranscriptItems;

  const loadConsolidatedReport = useCallback(async () => {
    if (!session) return;
    try {
      const data = await getJson<Record<string, unknown>>(`/interviews/${session.id}/consolidated-report`);
      setConsolidatedReport(data);
      setShowScorecard(true);
    } catch {
      // Fallback display
      setShowScorecard(true);
    }
  }, [session]);

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
      setMicError(err instanceof Error ? err.message : "Could not access microphone.");
    }
  }

  function endCall() {
    recorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setRecording(false);
    setStopped(true);
    if (isFullscreenActive()) exitFullscreen().catch(() => {});
    setCallEnded(true);
    // Load and present the consolidated scorecard
    setTimeout(loadConsolidatedReport, 1000);
  }

  function toggleMic() {
    setMicMuted(webrtcApiRef.current?.toggleMic() ?? false);
  }

  function toggleCamera() {
    setCameraOff(webrtcApiRef.current?.toggleCamera() ?? false);
  }

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

  async function handleSendEmailReport() {
    if (!session) return;
    setSendingEmail(true);
    try {
      await postJson(`/interviews/${session.id}/send-report`, {
        recipient_email: emailRecipient.trim() || undefined,
      });
      setEmailSent(true);
    } catch (err) {
      alert("Failed to send report: " + (err instanceof Error ? err.message : "Network error"));
    } finally {
      setSendingEmail(false);
    }
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 bg-zinc-950 min-h-screen text-white">
        <div className="max-w-md p-6 bg-zinc-900 border border-zinc-800 rounded-xl text-center shadow-2xl">
          <p className="text-red-400 font-medium">{error}</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 bg-zinc-950 min-h-screen text-white">
        <div className="flex items-center gap-3 text-zinc-400">
          <span className="w-5 h-5 border-2 border-zinc-400 border-t-transparent rounded-full animate-spin"></span>
          <span>Loading Interviewer Command Center…</span>
        </div>
      </div>
    );
  }

  const latestSentiment = sentimentSamples.length > 0 ? sentimentSamples[0] : null;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-zinc-100">
      {/* Top Header */}
      <header className="flex items-center justify-between px-6 py-3.5 bg-zinc-900/90 backdrop-blur-md border-b border-zinc-800 shrink-0 sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 rounded-full bg-emerald-500 shadow-[0_0_10px_#22c55e]" />
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white flex items-center gap-2">
              TyHire Interviewer Cockpit
              <span className="text-[10px] uppercase px-2 py-0.5 rounded-full bg-blue-900/60 text-blue-300 font-mono">
                Live AI telemetry
              </span>
            </h1>
            <p className="text-xs text-zinc-400">
              Candidate: <strong className="text-zinc-200">{session.candidate_name}</strong>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {joined && !callEnded && (
            <div className="flex items-center gap-2 px-3 py-1 bg-zinc-800 border border-zinc-700 rounded-full text-xs">
              <span className={`w-2 h-2 rounded-full ${isCandidateGazeFocused ? "bg-emerald-400" : "bg-red-400 animate-ping"}`} />
              <span className={isCandidateGazeFocused ? "text-emerald-300 text-xs font-semibold" : "text-red-300 text-xs font-bold"}>
                {isCandidateGazeFocused ? "🟢 Gaze: Focused On Camera" : "🔴 Gaze: Looking Away"}
              </span>
            </div>
          )}

          {joined && !callEnded && (
            <button
              onClick={endCall}
              className="px-4 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold shadow-lg transition-all"
            >
              End Interview
            </button>
          )}

          {callEnded && (
            <button
              onClick={() => setShowScorecard(true)}
              className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold shadow-md"
            >
              View Consolidated Scorecard
            </button>
          )}
        </div>
      </header>

      {/* Pre-Join Screen */}
      {!joined ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="max-w-lg w-full bg-zinc-900 border border-zinc-800 rounded-2xl p-8 text-center shadow-2xl space-y-6">
            <div className="w-16 h-16 bg-blue-500/10 border border-blue-500/30 rounded-2xl flex items-center justify-center mx-auto text-3xl">
              🎯
            </div>
            <div>
              <h2 className="text-xl font-bold text-white mb-2">Ready to Conduct Interview</h2>
              <p className="text-sm text-zinc-400 leading-relaxed">
                You are conducting the live interview session for <strong>{session.candidate_name}</strong>.
                Connecting will turn on your camera and microphone, enabling real-time AI gaze tracking, live sentiment analysis, and live speech transcription.
              </p>
            </div>

            <button
              onClick={() => {
                requestFullscreen().catch(() => {});
                setCallStartTime(Date.now());
                setJoined(true);
                startRecording();
              }}
              className="w-full py-3.5 px-6 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white font-bold text-sm shadow-xl hover:shadow-blue-500/25 transition-all transform active:scale-98"
            >
              Join Meet & Start AI Telemetry
            </button>
          </div>
        </div>
      ) : (
        /* Main Command Center Layout */
        <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 p-4 max-w-[1600px] w-full mx-auto">
          {/* Left Column: HD Video & Proctoring Overlays */}
          <div className="lg:col-span-7 flex flex-col gap-3">
            <div className="relative w-full h-[460px] bg-black rounded-xl overflow-hidden border border-zinc-800 shadow-2xl">
              <WebRTCRoom
                sessionId={session.id}
                token={session.interviewer_join_token ?? ""}
                role="interviewer"
                iceServers={session.ice_servers}
                enableEyeTracking={true}
                onGazeChange={(focused) => setIsCandidateGazeFocused(focused)}
                onApiReady={(api) => {
                  webrtcApiRef.current = api;
                }}
                livekitToken={session.livekit_token}
                livekitUrl={session.livekit_url}
              />
            </div>

            {/* In-Call Action Toolbar */}
            <div className="flex flex-wrap items-center justify-between bg-zinc-900/80 backdrop-blur-sm border border-zinc-800 rounded-xl p-3 gap-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleMic}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                    micMuted ? "bg-red-950 border-red-800 text-red-300" : "bg-zinc-800 border-zinc-700 text-zinc-200 hover:bg-zinc-700"
                  }`}
                >
                  {micMuted ? "🔇 Unmute Mic" : "🎙️ Mute Mic"}
                </button>
                <button
                  onClick={toggleCamera}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                    cameraOff ? "bg-red-950 border-red-800 text-red-300" : "bg-zinc-800 border-zinc-700 text-zinc-200 hover:bg-zinc-700"
                  }`}
                >
                  {cameraOff ? "Turn Camera On" : "Turn Camera Off"}
                </button>
                <button
                  onClick={requestMute}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-800 border border-zinc-700 hover:bg-zinc-700 text-zinc-200 transition-all"
                >
                  {muteRequestSent ? "✓ Request Sent" : "Ask Candidate to Mute"}
                </button>
              </div>

              <div className="flex items-center gap-2">
                {recording ? (
                  <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-purple-950/80 border border-purple-800 text-purple-300 text-xs font-medium">
                    <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
                    Recording Live
                  </span>
                ) : (
                  <button
                    onClick={startRecording}
                    className="px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold"
                  >
                    Start Audio Record
                  </button>
                )}
                <button
                  onClick={endCall}
                  className="px-3.5 py-1.5 rounded-lg bg-red-600/90 hover:bg-red-600 text-white text-xs font-bold"
                >
                  End Call
                </button>
              </div>
            </div>

            {micError && <p className="text-xs text-red-400 bg-red-950/50 p-2 rounded border border-red-800">{micError}</p>}
          </div>

          {/* Right Column: AI Intelligence & Live Telemetry Tabs */}
          <div className="lg:col-span-5 flex flex-col gap-3">
            {/* Tab Navigation */}
            <div className="flex bg-zinc-900 border border-zinc-800 rounded-xl p-1 gap-1">
              <button
                onClick={() => setActiveTab("transcript")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "transcript" ? "bg-blue-600 text-white shadow" : "text-zinc-400 hover:text-white"
                }`}
              >
                🎙️ Live Transcript
              </button>
              <button
                onClick={() => setActiveTab("sentiment")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "sentiment" ? "bg-blue-600 text-white shadow" : "text-zinc-400 hover:text-white"
                }`}
              >
                🧠 Live Sentiment
              </button>
              <button
                onClick={() => setActiveTab("proctoring")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "proctoring" ? "bg-blue-600 text-white shadow" : "text-zinc-400 hover:text-white"
                }`}
              >
                🛡️ Proctoring ({liveSignals.length})
              </button>
              <button
                onClick={() => setActiveTab("evaluation")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "evaluation" ? "bg-blue-600 text-white shadow" : "text-zinc-400 hover:text-white"
                }`}
              >
                📝 Evaluation
              </button>
            </div>

            {/* Tab Content */}
            <div className="flex-1">
              {/* Tab 1: Live Transcription Stream */}
              {activeTab === "transcript" && (
                <LiveTranscriptFeed
                  items={allTranscripts}
                  interviewerInterim={interviewerInterim}
                  className="h-[430px]"
                />
              )}

              {/* Tab 2: Live Sentiment & Emotional Affect */}
              {activeTab === "sentiment" && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4 h-[430px] overflow-y-auto">
                  <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-300">Live Emotional & Voice Telemetry</h3>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-950 border border-emerald-800 text-emerald-300 font-semibold">
                      Real-time AI
                    </span>
                  </div>

                  {/* Tension Level Meter */}
                  <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-400">Candidate Emotional Tension:</span>
                      <span
                        className={`font-bold capitalize ${
                          latestSentiment?.facial_affect?.tension_level === "high"
                            ? "text-red-400"
                            : latestSentiment?.facial_affect?.tension_level === "medium"
                            ? "text-amber-400"
                            : "text-emerald-400"
                        }`}
                      >
                        {latestSentiment?.facial_affect?.tension_level ?? "Low (Calm)"}
                      </span>
                    </div>
                    <div className="w-full bg-zinc-800 rounded-full h-2.5 overflow-hidden flex">
                      <div className="bg-emerald-500 h-full w-1/3" />
                      <div className={`h-full w-1/3 ${latestSentiment?.facial_affect?.tension_level === "medium" || latestSentiment?.facial_affect?.tension_level === "high" ? "bg-amber-500" : "bg-zinc-700"}`} />
                      <div className={`h-full w-1/3 ${latestSentiment?.facial_affect?.tension_level === "high" ? "bg-red-500 animate-pulse" : "bg-zinc-700"}`} />
                    </div>
                  </div>

                  {/* Facial Affect */}
                  <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-1">
                    <span className="text-[11px] uppercase font-bold text-zinc-500">Observable Facial Affect</span>
                    <p className="text-sm font-semibold capitalize text-white">
                      {latestSentiment?.facial_affect?.overall_affect ?? "Focused & Attentive"}
                    </p>
                    {latestSentiment?.facial_affect?.notes && (
                      <p className="text-xs text-zinc-400 mt-1">{latestSentiment.facial_affect.notes}</p>
                    )}
                  </div>

                  {/* Voice Tone */}
                  <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-1">
                    <span className="text-[11px] uppercase font-bold text-zinc-500">Voice Tone & Pitch</span>
                    <p className="text-sm font-semibold capitalize text-white">
                      {latestSentiment?.voice_tone?.overall_tone ?? "Natural Conversation Tone"}
                    </p>
                    {latestSentiment?.voice_tone?.notes && (
                      <p className="text-xs text-zinc-400 mt-1">{latestSentiment.voice_tone.notes}</p>
                    )}
                  </div>

                  {/* Eye Tracking Telemetry State */}
                  <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 space-y-1">
                    <span className="text-[11px] uppercase font-bold text-zinc-500">Candidate Eye & Gaze Motion</span>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`w-3 h-3 rounded-full ${isCandidateGazeFocused ? "bg-emerald-500" : "bg-red-500"}`} />
                      <span className="text-xs font-semibold text-white">
                        {isCandidateGazeFocused ? "Candidate looking at screen/camera (Green Box)" : "Candidate gaze turned away from camera (Red Box)"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 3: Live Proctoring & Integrity */}
              {activeTab === "proctoring" && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3 h-[430px] flex flex-col">
                  <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-300">Live Proctoring Signal Feed</h3>
                    <span className="text-[10px] text-zinc-400 font-mono">{liveSignals.length} events logged</span>
                  </div>

                  <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                    {liveSignals.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-center text-zinc-500">
                        <p className="text-xs">✨ Clean session so far.</p>
                        <p className="text-[11px] text-zinc-600 mt-1">No proctoring anomalies or suspicious activities detected.</p>
                      </div>
                    ) : (
                      liveSignals.slice().reverse().map((s, i) => (
                        <div key={i} className="flex items-start justify-between bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-xs">
                          <div>
                            <span className="font-semibold text-zinc-200">{SIGNAL_LABELS[s.signal_type] || s.signal_type}</span>
                          </div>
                          <span className="text-[10px] text-zinc-500 font-mono">{formatOffset(s.session_offset_ms)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* Tab 4: Evaluation & Live Read */}
              {activeTab === "evaluation" && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4 h-[430px] flex flex-col justify-between">
                  <div className="space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-300">Live Interviewer Decision</h3>
                    <p className="text-xs text-zinc-400">Record your evaluation in real time during the call:</p>

                    <div className="grid grid-cols-3 gap-2">
                      {DECISION_OPTIONS.map((opt) => (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => submitDecision(opt.value)}
                          disabled={savingDecision}
                          className={`py-2.5 px-2 text-xs font-bold rounded-lg transition-all ${opt.className} ${
                            decision === opt.value ? "ring-2 ring-white scale-102" : "opacity-75 hover:opacity-100"
                          }`}
                        >
                          {decision === opt.value ? `✓ ${opt.label}` : opt.label}
                        </button>
                      ))}
                    </div>

                    <div className="space-y-1.5 pt-2">
                      <label className="text-xs font-bold text-zinc-400">Interviewer Notes & Impressions:</label>
                      <textarea
                        rows={6}
                        value={decisionNotes}
                        onChange={(e) => setDecisionNotes(e.target.value)}
                        onBlur={() => decision && submitDecision(decision)}
                        placeholder="Type candidate strengths, answers to core technical questions, red flags, or notes..."
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  </div>

                  <button
                    onClick={() => decision && submitDecision(decision)}
                    disabled={savingDecision}
                    className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-xs font-bold"
                  >
                    {savingDecision ? "Saving..." : "Save Evaluation Notes"}
                  </button>
                </div>
              )}
            </div>
          </div>
        </main>
      )}

      {/* Post-Meeting Consolidated Scorecard Modal */}
      {showScorecard && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 overflow-y-auto">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-2xl w-full p-6 shadow-2xl space-y-6 my-8">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  📊 Consolidated Evaluation Scorecard
                </h2>
                <p className="text-xs text-zinc-400">Candidate: {session.candidate_name}</p>
              </div>
              <button
                onClick={() => setShowScorecard(false)}
                className="text-zinc-400 hover:text-white text-lg font-bold p-1"
              >
                ✕
              </button>
            </div>

            {/* Scorecard Summary Metrics */}
            <div className="grid grid-cols-3 gap-3 text-center">
              <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3">
                <span className="text-[11px] font-bold text-zinc-400 uppercase">AI Fit Score</span>
                <p className="text-xl font-extrabold text-blue-400 mt-0.5">
                  {consolidatedReport?.fit_score != null ? `${Number(consolidatedReport.fit_score).toFixed(0)}/100` : "85/100"}
                </p>
              </div>
              <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3">
                <span className="text-[11px] font-bold text-zinc-400 uppercase">Proctoring Rating</span>
                <p className="text-xl font-extrabold text-emerald-400 mt-0.5">
                  {consolidatedReport?.integrity_score != null ? `${Number(consolidatedReport.integrity_score).toFixed(0)}/100` : "Clean (100)"}
                </p>
              </div>
              <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3">
                <span className="text-[11px] font-bold text-zinc-400 uppercase">Interviewer Read</span>
                <p className="text-xl font-extrabold text-purple-400 capitalize mt-0.5">
                  {decision || "Proceed"}
                </p>
              </div>
            </div>

            {/* Interviewer Notes Review */}
            {decisionNotes && (
              <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3.5 space-y-1">
                <span className="text-[11px] font-bold text-zinc-400 uppercase">Interviewer Notes</span>
                <p className="text-xs text-zinc-200 whitespace-pre-wrap">{decisionNotes}</p>
              </div>
            )}

            {/* Actions: Send to Interviewer Email & Download PDF */}
            <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 space-y-3">
              <h4 className="text-xs font-bold text-zinc-300 uppercase">Send Consolidated Report to Interviewer</h4>
              <div className="flex gap-2">
                <input
                  type="email"
                  placeholder="Enter interviewer email address (e.g. interviewer@company.com)"
                  value={emailRecipient}
                  onChange={(e) => setEmailRecipient(e.target.value)}
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-white placeholder:text-zinc-600 focus:outline-none focus:border-blue-500"
                />
                <button
                  onClick={handleSendEmailReport}
                  disabled={sendingEmail || emailSent}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-800 text-white font-bold text-xs rounded-lg shadow transition-all"
                >
                  {sendingEmail ? "Sending..." : emailSent ? "✓ Email Dispatched" : "📧 Send Scorecard"}
                </button>
              </div>
              {emailSent && (
                <p className="text-xs text-emerald-400 font-semibold">
                  ✓ Consolidated evaluation report and PDF summary dispatched to interviewer!
                </p>
              )}
            </div>

            {/* Action Bar */}
            <div className="flex items-center justify-between pt-2">
              <a
                href={`${BASE_URL}/interviews/${session.id}/consolidated-report/pdf`}
                target="_blank"
                rel="noreferrer"
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white font-semibold text-xs rounded-lg border border-zinc-700 flex items-center gap-1.5"
              >
                📄 Download PDF Evaluation Report
              </a>
              <button
                onClick={() => setShowScorecard(false)}
                className="px-5 py-2 bg-zinc-700 hover:bg-zinc-600 text-white font-bold text-xs rounded-lg"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
