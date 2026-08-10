"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { BASE_URL, getJson, postJson } from "@/lib/api";
import { getIntegrityScoreBand, getSeverityBand } from "@/lib/integrityLabel";
import type { IdentityCheck, IntegrityFlag, InterviewSession, QaExchange } from "@/lib/types";

const QA_VERDICT_STYLE: Record<QaExchange["verdict"], string> = {
  relevant: "bucket-approved",
  partially_relevant: "bucket-review",
  off_topic: "bucket-declined",
  evasive: "bucket-declined",
};

export default function ReviewDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [flags, setFlags] = useState<IntegrityFlag[]>([]);
  const [identityCheck, setIdentityCheck] = useState<IdentityCheck | null>(null);
  const [recordingUrl, setRecordingUrl] = useState<string | null>(null);
  // Distinguishes "still loading" from "the fetch failed" — without it a failed session
  // fetch left the page on "Loading…" forever (and an unhandled promise rejection).
  const [loadError, setLoadError] = useState(false);

  // Fetched (not a plain <video src>) so the HR session cookie is reliably sent and the
  // recording — possibly encrypted at rest — goes through the authenticated, decrypting
  // /media/recording route rather than the old unauthenticated static file mount.
  useEffect(() => {
    if (!session?.recording_file_path) {
      setRecordingUrl(null);
      return;
    }
    let objectUrl: string | null = null;
    fetch(`${BASE_URL}/interviews/${sessionId}/media/recording`, { credentials: "include" })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (blob) {
          objectUrl = URL.createObjectURL(blob);
          setRecordingUrl(objectUrl);
        }
      })
      .catch(() => {});
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [session?.recording_file_path, sessionId]);

  const refresh = useCallback(() => {
    getJson<InterviewSession>(`/interviews/${sessionId}`)
      .then((s) => {
        setSession(s);
        setLoadError(false);
      })
      .catch(() => setLoadError(true));
    getJson<IntegrityFlag[]>(`/interviews/${sessionId}/flags`)
      .then(setFlags)
      .catch(() => setFlags([]));
    getJson<IdentityCheck>(`/interviews/${sessionId}/identity-check`)
      .then(setIdentityCheck)
      .catch(() => setIdentityCheck(null));
  }, [sessionId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Transcription runs in the background after the interview ends — poll until it's done.
  useEffect(() => {
    if (session?.transcript_status !== "pending") return;
    const interval = setInterval(refresh, 4000);
    return () => clearInterval(interval);
  }, [session?.transcript_status, refresh]);

  async function decide(flagId: string, decision: "cleared" | "confirmed_issue") {
    const note = window.prompt("Optional note for the audit log:") ?? undefined;
    await postJson(`/interviews/flags/${flagId}/decision`, { decision, note });
    refresh();
  }

  async function clearIdentityCheck() {
    const reason = window.prompt(
      "Reason for clearing this no_match verdict as a false positive (e.g. bad lighting):"
    );
    if (!reason || !reason.trim()) return;
    await postJson(`/interviews/${sessionId}/identity-check/override`, { reason });
    refresh();
  }

  // Only a hard failure with nothing rendered yet becomes a dead end — a transient failure
  // during the transcript-polling refresh keeps the already-loaded page up instead.
  if (loadError && !session) {
    return (
      <div className="p-6 space-y-3 text-sm">
        <p className="text-red-600">
          Couldn&apos;t load this review session. It may not exist, or your login may have
          expired.
        </p>
        <button onClick={refresh} className="btn-primary">
          Try again
        </button>
      </div>
    );
  }
  if (!session) return <p className="p-6 text-zinc-500">Loading…</p>;

  return (
    <div className="max-w-3xl mx-auto w-full px-6 py-8 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{session.candidate_name}</h1>
        <p className="text-sm text-zinc-500 flex items-center gap-2 mt-1">
          {session.integrity_score !== null ? (
            <span className={`text-xs ${getIntegrityScoreBand(session.integrity_score).badgeClass}`}>
              {getIntegrityScoreBand(session.integrity_score).label}
            </span>
          ) : (
            <span>Integrity score: —</span>
          )}
          {session.integrity_score !== null && (
            <span className="text-xs text-zinc-400">({session.integrity_score}/100)</span>
          )}
          <span>· Status: {session.status}</span>
        </p>
      </div>

      {identityCheck && (
        <div>
          <h2 className="font-medium mb-2">Identity check</h2>
          <div className="border border-zinc-200 rounded-md p-3 text-sm space-y-1">
            <p>
              Verdict: <span className="font-medium">{identityCheck.match_verdict ?? "—"}</span>
              {identityCheck.match_confidence !== null &&
                ` (confidence ${(identityCheck.match_confidence * 100).toFixed(0)}%)`}
            </p>
            {session.candidate_ip && (
              <p className="text-xs text-zinc-500">Candidate IP: {session.candidate_ip}</p>
            )}
            {identityCheck.cleared_by_hr && (
              <p className="text-xs text-emerald-700">
                Cleared by HR — {identityCheck.cleared_reason}
              </p>
            )}
            {identityCheck.match_verdict === "no_match" && !identityCheck.cleared_by_hr && (
              <button onClick={clearIdentityCheck} className="btn-outline text-xs px-2 py-1">
                Clear as false positive
              </button>
            )}
          </div>
        </div>
      )}

      {session.interviewer_live_decision && (
        <div>
          <h2 className="font-medium mb-2">Interviewer&apos;s live read</h2>
          <div className="border border-zinc-200 rounded-md p-3 text-sm">
            <p className="font-medium capitalize">{session.interviewer_live_decision}</p>
            {session.interviewer_live_notes && (
              <p className="text-xs text-zinc-600 mt-1">{session.interviewer_live_notes}</p>
            )}
          </div>
        </div>
      )}

      {recordingUrl && (
        <video controls className="w-full max-w-lg rounded-md bg-black" src={recordingUrl} />
      )}

      {session.transcript_status && (
        <div>
          <h2 className="font-medium mb-2">
            Transcript
            {session.merged_transcript && (
              <span className="text-xs font-normal text-zinc-500 ml-2">
                (interviewer + candidate, merged by timestamp)
              </span>
            )}
          </h2>
          {session.transcript_status === "pending" && (
            <p className="text-sm text-zinc-500">Transcribing… this updates automatically.</p>
          )}
          {session.transcript_status === "failed" && (
            <p className="text-sm text-red-600">{session.transcript}</p>
          )}
          {session.transcript_status === "done" && (
            <div className="max-h-64 overflow-y-auto border border-zinc-200 rounded-md p-3 text-sm text-zinc-700 whitespace-pre-wrap">
              {session.merged_transcript || session.transcript}
            </div>
          )}
          {session.interviewer_join_token && !session.interviewer_recording_file_path && (
            <p className="text-xs text-amber-700 mt-1">
              No interviewer recording was captured for this session — only the candidate's
              side is shown above.
            </p>
          )}
        </div>
      )}

      {session.voice_tone_analysis && (
        <div>
          <h2 className="font-medium mb-2">
            Voice tone <span className="text-xs font-normal text-zinc-500">(candidate, supplementary — not scored)</span>
          </h2>
          {session.voice_tone_analysis.error ? (
            <p className="text-sm text-red-600">Analysis failed: {session.voice_tone_analysis.error}</p>
          ) : (
            <div className="border border-zinc-200 rounded-md p-3 text-sm">
              <p>
                <span className="font-medium capitalize">{session.voice_tone_analysis.overall_tone}</span>
                {" "}· confidence: {session.voice_tone_analysis.confidence_level}
              </p>
              <p className="text-xs text-zinc-600 mt-1">{session.voice_tone_analysis.notes}</p>
            </div>
          )}
        </div>
      )}

      {session.facial_affect_analysis && (
        <div>
          <h2 className="font-medium mb-2">
            Facial affect{" "}
            <span className="text-xs font-normal text-zinc-500">
              (candidate, supplementary — not scored, treat with caution)
            </span>
          </h2>
          {session.facial_affect_analysis.error ? (
            <p className="text-sm text-red-600">Analysis failed: {session.facial_affect_analysis.error}</p>
          ) : !session.facial_affect_analysis.face_visible ? (
            <p className="text-sm text-zinc-500">
              No face was clearly visible in the sampled frames — no assessment made.
            </p>
          ) : (
            <div className="border border-zinc-200 rounded-md p-3 text-sm">
              <p>
                <span className="font-medium capitalize">{session.facial_affect_analysis.overall_affect}</span>
                {" "}· tension: {session.facial_affect_analysis.tension_level}
              </p>
              <p className="text-xs text-zinc-600 mt-1">{session.facial_affect_analysis.notes}</p>
              <p className="text-xs text-amber-700 mt-2">
                Anxiety, cultural expressiveness differences, neurodivergence, and camera
                unfamiliarity can all look like &quot;tension&quot; without meaning anything —
                weigh this signal accordingly.
              </p>
            </div>
          )}
        </div>
      )}

      {session.sentiment_trend && (
        <div>
          <h2 className="font-medium mb-2">
            Sentiment trend{" "}
            <span className="text-xs font-normal text-zinc-500">
              (aggregated across the whole call, supplementary — not scored)
            </span>
          </h2>
          <div className="border border-zinc-200 rounded-md p-3 text-sm">
            <p>{session.sentiment_trend.summary}</p>
            <p className="text-xs text-zinc-500 mt-1">
              {session.sentiment_trend.sample_count} periodic readings — low{" "}
              {session.sentiment_trend.tension_distribution.low}, medium{" "}
              {session.sentiment_trend.tension_distribution.medium}, high{" "}
              {session.sentiment_trend.tension_distribution.high}
            </p>
          </div>
        </div>
      )}

      {session.qa_analysis && (
        <div>
          <h2 className="font-medium mb-2">Question / answer check</h2>
          {session.qa_analysis.error ? (
            <p className="text-sm text-red-600">Analysis failed: {session.qa_analysis.error}</p>
          ) : session.qa_analysis.no_questions_detected ? (
            <p className="text-sm text-zinc-500">
              No interviewer questions were detected in the audio — this only captures the
              candidate&apos;s own microphone, so cross-verification isn&apos;t possible for
              this session.
            </p>
          ) : session.qa_analysis.exchanges.length === 0 ? (
            <p className="text-sm text-zinc-500">No distinct question/answer exchanges found.</p>
          ) : (
            <ul className="space-y-2">
              {session.qa_analysis.exchanges.map((ex, i) => (
                <li key={i} className={`border rounded-md p-3 text-sm ${QA_VERDICT_STYLE[ex.verdict]}`}>
                  <p className="font-medium">Q: {ex.question}</p>
                  <p className="mt-1">A: {ex.answer}</p>
                  <p className="text-xs mt-2 opacity-80">
                    {ex.verdict.replace("_", " ")} — {ex.explanation}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div>
        <h2 className="font-medium mb-2">Flagged moments</h2>
        {flags.length === 0 && (
          <p className="text-sm text-zinc-500">No flagged moments — clean session.</p>
        )}
        <ul className="space-y-2">
          {flags.map((f) => (
            <li key={f.id} className="border border-zinc-200 rounded-md p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span>
                  {formatOffset(f.session_offset_ms)} — {f.summary}
                </span>
                <span
                  className={`shrink-0 text-xs ${getSeverityBand(f.severity).badgeClass}`}
                  title={`raw severity ${f.severity.toFixed(1)}`}
                >
                  {getSeverityBand(f.severity).label}
                </span>
              </div>
              {f.reviewed ? (
                <p className="text-xs text-zinc-500 mt-1">
                  Reviewed: {f.reviewer_decision} {f.reviewer_note ? `— ${f.reviewer_note}` : ""}
                </p>
              ) : (
                <div className="flex gap-2 mt-2">
                  <button onClick={() => decide(f.id, "cleared")} className="btn-outline text-xs px-2 py-1">
                    Clear
                  </button>
                  <button
                    onClick={() => decide(f.id, "confirmed_issue")}
                    className="btn-danger-outline"
                  >
                    Confirm issue
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
