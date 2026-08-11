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

export interface SuggestedQuestion {
  id: string;
  category: string;
  question: string;
  context_reason: string;
  expected_concepts: string[];
  difficulty: string;
}

export interface AnswerEvaluation {
  accuracy_score: number;
  verdict: "strong" | "partially_correct" | "superficial" | "inaccurate" | "scripted_delivery";
  concepts_covered: string[];
  concepts_missing: string[];
  depth_rating: "deep" | "adequate" | "surface";
  fluff_detected: boolean;
  teleprompter_speech_flag: boolean;
  hr_summary: string;
  suggested_followup: string;
}

export interface RatedQuestion {
  question_id: string;
  question_text: string;
  rating: string;
  accuracy_score?: number;
  notes?: string;
  concepts_covered: string[];
  concepts_missing: string[];
  timestamp: string;
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
  teleprompter_reading: "Teleprompter / Script-reading eye motion pattern",
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
  const [activeTab, setActiveTab] = useState<"questions" | "transcript" | "sentiment" | "proctoring" | "evaluation">("questions");
  const [isCandidateGazeFocused, setIsCandidateGazeFocused] = useState(true);
  const [isTeleprompterReading, setIsTeleprompterReading] = useState(false);

  // AI-Suggested Questions & Live Answer Evaluation
  const [suggestedQuestions, setSuggestedQuestions] = useState<SuggestedQuestion[]>([]);
  const [activeQuestion, setActiveQuestion] = useState<SuggestedQuestion | null>(null);
  const [activeEvaluation, setActiveEvaluation] = useState<AnswerEvaluation | null>(null);
  const [evaluatingAnswer, setEvaluatingAnswer] = useState(false);
  const [ratedQuestions, setRatedQuestions] = useState<RatedQuestion[]>([]);

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

  // Fetch AI-suggested questions
  useEffect(() => {
    if (!session) return;
    getJson<SuggestedQuestion[]>(`/interviews/${session.id}/suggested-questions`)
      .then((questions) => {
        if (questions && questions.length > 0) {
          setSuggestedQuestions(questions);
          setActiveQuestion(questions[0]);
        }
      })
      .catch(() => {});

    getJson<RatedQuestion[]>(`/interviews/${session.id}/qa-evaluations`)
      .then((evals) => {
        if (evals) setRatedQuestions(evals);
      })
      .catch(() => {});
  }, [session]);

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

  const allTranscripts = mergedLiveTranscripts.length > 0
    ? mergedLiveTranscripts
    : interviewerTranscriptItems;

  // Real-time answer evaluation trigger
  const runAnswerEvaluation = useCallback(async () => {
    if (!session || !activeQuestion) return;
    // Collect candidate spoken text
    const candidateSpeech = allTranscripts
      .filter((t) => t.speaker === "candidate")
      .map((t) => t.text)
      .join(" ");

    if (candidateSpeech.length < 15) return;

    setEvaluatingAnswer(true);
    try {
      const evalResult = await postJson<AnswerEvaluation>(`/interviews/${session.id}/evaluate-live-answer`, {
        question_id: activeQuestion.id,
        question_text: activeQuestion.question,
        expected_concepts: activeQuestion.expected_concepts,
        candidate_transcript: candidateSpeech,
      });
      setActiveEvaluation(evalResult);
    } catch {
      // Degrade gracefully
    } finally {
      setEvaluatingAnswer(false);
    }
  }, [session, activeQuestion, allTranscripts]);

  // Debounced answer evaluation when new transcripts arrive
  useEffect(() => {
    if (!activeQuestion || allTranscripts.length === 0) return;
    const timer = setTimeout(() => {
      runAnswerEvaluation();
    }, 3500);
    return () => clearTimeout(timer);
  }, [allTranscripts, activeQuestion, runAnswerEvaluation]);

  async function handleRateQuestion(rating: "strong_pass" | "needs_followup" | "inaccurate_scripted") {
    if (!session || !activeQuestion) return;
    const accuracy = activeEvaluation?.accuracy_score ?? 80;
    try {
      const res = await postJson<{ qa_evaluations: RatedQuestion[] }>(`/interviews/${session.id}/rate-question-answer`, {
        question_id: activeQuestion.id,
        question_text: activeQuestion.question,
        rating,
        accuracy_score: accuracy,
        concepts_covered: activeEvaluation?.concepts_covered ?? [],
        concepts_missing: activeEvaluation?.concepts_missing ?? [],
      });
      if (res.qa_evaluations) setRatedQuestions(res.qa_evaluations);
    } catch {}
  }

  const loadConsolidatedReport = useCallback(async () => {
    if (!session) return;
    try {
      const data = await getJson<Record<string, unknown>>(`/interviews/${session.id}/consolidated-report`);
      setConsolidatedReport(data);
      setShowScorecard(true);
    } catch {
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
    <div className="flex flex-col min-h-screen bg-zinc-950 text-zinc-100 font-sans">
      {/* Top Header */}
      <header className="flex items-center justify-between px-6 py-3.5 bg-zinc-900/90 backdrop-blur-md border-b border-zinc-800 shrink-0 sticky top-0 z-20">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 rounded-full bg-emerald-500 shadow-[0_0_10px_#22c55e]" />
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white flex items-center gap-2">
              TyHire Interviewer Cockpit
              <span className="text-[10px] uppercase px-2 py-0.5 rounded-full bg-blue-900/60 text-blue-300 font-mono">
                GPT Telemetry & Gaze AI
              </span>
            </h1>
            <p className="text-xs text-zinc-400">
              Candidate: <strong className="text-zinc-200">{session.candidate_name}</strong>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {joined && !callEnded && isTeleprompterReading && (
            <div className="flex items-center gap-2 px-3 py-1 bg-purple-950/90 border border-purple-700 rounded-full text-xs animate-pulse">
              <span className="w-2.5 h-2.5 rounded-full bg-purple-400 shadow-[0_0_8px_#c084fc]" />
              <span className="text-purple-200 font-bold">⚠️ Teleprompter Script Reading Detected</span>
            </div>
          )}

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
                Conduct the interview for <strong>{session.candidate_name}</strong> with real-time GPT question guidance, live answer accuracy analysis, teleprompter eye gaze detection, and live transcription.
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
          {/* Left Column: HD Video & Active Question / Then-and-There Decision */}
          <div className="lg:col-span-7 flex flex-col gap-3">
            <div className="relative w-full h-[420px] bg-black rounded-xl overflow-hidden border border-zinc-800 shadow-2xl">
              <WebRTCRoom
                sessionId={session.id}
                token={session.interviewer_join_token ?? ""}
                role="interviewer"
                iceServers={session.ice_servers}
                enableEyeTracking={true}
                onGazeChange={(focused, isTeleprompter) => {
                  setIsCandidateGazeFocused(focused);
                  if (isTeleprompter !== undefined) setIsTeleprompterReading(isTeleprompter);
                }}
                onApiReady={(api) => {
                  webrtcApiRef.current = api;
                }}
                livekitToken={session.livekit_token}
                livekitUrl={session.livekit_url}
              />
            </div>

            {/* Active Question & "Then and There" Instant Decision Bar */}
            {activeQuestion && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-blue-950 border border-blue-800 text-blue-300">
                    Active Question · {activeQuestion.category}
                  </span>
                  <div className="flex items-center gap-2">
                    {evaluatingAnswer && (
                      <span className="text-[11px] text-blue-400 animate-pulse font-medium flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-blue-400 animate-ping"></span>
                        GPT Evaluating Answer…
                      </span>
                    )}
                    {activeEvaluation && (
                      <span className="text-xs font-bold px-2 py-0.5 rounded bg-emerald-950 border border-emerald-800 text-emerald-300">
                        Accuracy: {activeEvaluation.accuracy_score.toFixed(0)}/100
                      </span>
                    )}
                  </div>
                </div>

                <p className="text-xs font-semibold text-white leading-relaxed">{activeQuestion.question}</p>

                {/* Concept Checklist */}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {activeQuestion.expected_concepts.map((concept, idx) => {
                    const isCovered = activeEvaluation?.concepts_covered.includes(concept);
                    return (
                      <span
                        key={idx}
                        className={`text-[10px] font-medium px-2 py-0.5 rounded-full border transition-all ${
                          isCovered
                            ? "bg-emerald-950/80 border-emerald-700 text-emerald-300"
                            : "bg-zinc-950 border-zinc-800 text-zinc-400"
                        }`}
                      >
                        {isCovered ? "✓" : "○"} {concept}
                      </span>
                    );
                  })}
                </div>

                {/* Adaptive Follow-up Prompt */}
                {activeEvaluation?.suggested_followup && (
                  <div className="p-2 rounded-lg bg-indigo-950/40 border border-indigo-800/50 text-[11px] text-indigo-200">
                    <strong className="text-indigo-300">💡 Suggested Follow-up: </strong>
                    {activeEvaluation.suggested_followup}
                  </div>
                )}

                {/* "Then and There" 1-Click Evaluation Buttons */}
                <div className="flex items-center justify-between pt-1 border-t border-zinc-800/80">
                  <span className="text-[11px] font-bold text-zinc-400">Rate Answer Then & There:</span>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => handleRateQuestion("strong_pass")}
                      className="px-2.5 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-[11px] font-bold transition-all"
                    >
                      🟢 Strong Pass
                    </button>
                    <button
                      onClick={() => handleRateQuestion("needs_followup")}
                      className="px-2.5 py-1 rounded bg-amber-700 hover:bg-amber-600 text-white text-[11px] font-bold transition-all"
                    >
                      🟡 Needs Follow-up
                    </button>
                    <button
                      onClick={() => handleRateQuestion("inaccurate_scripted")}
                      className="px-2.5 py-1 rounded bg-red-700 hover:bg-red-600 text-white text-[11px] font-bold transition-all"
                    >
                      🔴 Inaccurate / Scripted
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* In-Call Action Toolbar */}
            <div className="flex flex-wrap items-center justify-between bg-zinc-900/80 backdrop-blur-sm border border-zinc-800 rounded-xl p-2.5 gap-2">
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
                onClick={() => setActiveTab("questions")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "questions" ? "bg-blue-600 text-white shadow" : "text-zinc-400 hover:text-white"
                }`}
              >
                🤖 AI Questions ({suggestedQuestions.length})
              </button>
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
                🧠 Sentiment
              </button>
              <button
                onClick={() => setActiveTab("proctoring")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "proctoring" ? "bg-blue-600 text-white shadow" : "text-zinc-400 hover:text-white"
                }`}
              >
                🛡️ Signals ({liveSignals.length})
              </button>
              <button
                onClick={() => setActiveTab("evaluation")}
                className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  activeTab === "evaluation" ? "bg-blue-600 text-white shadow" : "text-zinc-400 hover:text-white"
                }`}
              >
                📝 Notes
              </button>
            </div>

            {/* Tab Content */}
            <div className="flex-1">
              {/* Tab 0: AI-Suggested Questions Bank */}
              {activeTab === "questions" && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 space-y-3 h-[450px] overflow-y-auto">
                  <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-300">GPT-Suggested Question Bank</h3>
                    <span className="text-[10px] text-zinc-400 font-mono">Tailored to Resume & JD</span>
                  </div>

                  <div className="space-y-2">
                    {suggestedQuestions.map((q) => {
                      const isSelected = activeQuestion?.id === q.id;
                      const hasRating = ratedQuestions.find((r) => r.question_id === q.id);
                      return (
                        <div
                          key={q.id}
                          className={`p-3 rounded-lg border text-xs transition-all ${
                            isSelected
                              ? "bg-blue-950/40 border-blue-600 ring-1 ring-blue-500"
                              : "bg-zinc-950 border-zinc-800 hover:border-zinc-700"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="font-semibold text-[10px] uppercase px-2 py-0.5 rounded bg-zinc-800 text-zinc-300">
                              {q.category} · {q.difficulty}
                            </span>
                            {hasRating && (
                              <span
                                className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                                  hasRating.rating === "strong_pass"
                                    ? "bg-emerald-900/60 text-emerald-300"
                                    : hasRating.rating === "needs_followup"
                                    ? "bg-amber-900/60 text-amber-300"
                                    : "bg-red-900/60 text-red-300"
                                }`}
                              >
                                ✓ {hasRating.rating.replace("_", " ")}
                              </span>
                            )}
                          </div>
                          <p className="font-medium text-white mb-2">{q.question}</p>
                          <p className="text-[11px] text-zinc-400 mb-2 italic">Context: {q.context_reason}</p>

                          <div className="flex items-center justify-between pt-1">
                            <span className="text-[10px] text-zinc-500">
                              Key concepts: {q.expected_concepts.join(", ")}
                            </span>
                            <button
                              onClick={() => {
                                setActiveQuestion(q);
                                setActiveEvaluation(null);
                              }}
                              className={`px-3 py-1 rounded text-[11px] font-bold ${
                                isSelected ? "bg-blue-600 text-white" : "bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                              }`}
                            >
                              {isSelected ? "Active Question" : "Ask Question"}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Tab 1: Live Transcription Stream */}
              {activeTab === "transcript" && (
                <LiveTranscriptFeed
                  items={allTranscripts}
                  interviewerInterim={interviewerInterim}
                  className="h-[450px]"
                />
              )}

              {/* Tab 2: Live Sentiment & Emotional Affect */}
              {activeTab === "sentiment" && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4 h-[450px] overflow-y-auto">
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
                      <span className={`w-3 h-3 rounded-full ${isTeleprompterReading ? "bg-purple-400" : isCandidateGazeFocused ? "bg-emerald-500" : "bg-red-500"}`} />
                      <span className="text-xs font-semibold text-white">
                        {isTeleprompterReading
                          ? "⚠️ Teleprompter Script Reading Detected (Horizontal scanning)"
                          : isCandidateGazeFocused
                          ? "Candidate looking at screen/camera (Green Box)"
                          : "Candidate gaze turned away from camera (Red Box)"}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 3: Live Proctoring & Integrity */}
              {activeTab === "proctoring" && (
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3 h-[450px] flex flex-col">
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
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4 h-[450px] flex flex-col justify-between">
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
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-3xl w-full p-6 shadow-2xl space-y-6 my-8">
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

            {/* Question Accuracy Scorecard */}
            {ratedQuestions.length > 0 && (
              <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-4 space-y-2.5">
                <h4 className="text-xs font-bold text-zinc-300 uppercase">AI-Evaluated Question Scorecard</h4>
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {ratedQuestions.map((rq, idx) => (
                    <div key={idx} className="p-2.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs flex items-start justify-between gap-3">
                      <div className="space-y-0.5">
                        <p className="font-semibold text-white">{rq.question_text}</p>
                        {rq.concepts_covered?.length > 0 && (
                          <p className="text-[11px] text-emerald-400">Covered: {rq.concepts_covered.join(", ")}</p>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <span className="font-bold text-blue-400">{rq.accuracy_score?.toFixed(0) ?? 85}/100</span>
                        <span className="block text-[10px] text-zinc-400 capitalize">{rq.rating.replace("_", " ")}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

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
