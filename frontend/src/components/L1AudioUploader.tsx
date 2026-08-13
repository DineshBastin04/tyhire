"use client";

import { useRef, useState, useEffect } from "react";
import { BASE_URL, postForm, getJson } from "@/lib/api";
import type { L1PhoneScreening } from "@/lib/types";

interface L1AudioUploaderProps {
  candidateId: string;
  candidateName: string;
  onScreeningComplete?: (screening: L1PhoneScreening) => void;
}

const VERDICT_STYLES: Record<string, { label: string; bg: string; text: string; border: string }> = {
  recommend_l1: {
    label: "Recommend L1 Technical",
    bg: "bg-emerald-50",
    text: "text-emerald-800",
    border: "border-emerald-300",
  },
  recommend_l2: {
    label: "Recommend L1 Technical",
    bg: "bg-emerald-50",
    text: "text-emerald-800",
    border: "border-emerald-300",
  },
  hold: {
    label: "On Hold",
    bg: "bg-amber-50",
    text: "text-amber-800",
    border: "border-amber-300",
  },
  decline: {
    label: "Decline Candidate",
    bg: "bg-red-50",
    text: "text-red-800",
    border: "border-red-300",
  },
  senior_review: {
    label: "Needs Senior HR Review",
    bg: "bg-blue-50",
    text: "text-blue-800",
    border: "border-blue-300",
  },
};

export default function L1AudioUploader({
  candidateId,
  candidateName,
  onScreeningComplete,
}: L1AudioUploaderProps) {
  const [screenings, setScreenings] = useState<L1PhoneScreening[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeScreening, setActiveScreening] = useState<L1PhoneScreening | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    getJson<L1PhoneScreening[]>(`/candidates/${candidateId}/l1-screening`)
      .then((data) => {
        setScreenings(data);
        if (data.length > 0) {
          setActiveScreening(data[0]);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [candidateId]);

  async function handleFileSelect(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];

    const form = new FormData();
    form.append("file", file);

    setUploading(true);
    setError(null);
    try {
      const result = await postForm<L1PhoneScreening>(
        `/candidates/${candidateId}/l1-audio`,
        form
      );
      setScreenings((prev) => [result, ...prev]);
      setActiveScreening(result);
      if (onScreeningComplete) {
        onScreeningComplete(result);
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload and analyze audio.");
    } finally {
      setUploading(false);
    }
  }

  function handleSeek(seconds: number) {
    if (audioRef.current) {
      audioRef.current.currentTime = seconds;
      audioRef.current.play();
    }
  }

  return (
    <div className="space-y-4">
      {/* Upload Zone */}
      <div className="border border-dashed border-zinc-300 hover:border-blue-400 bg-zinc-50/50 rounded-lg p-4 text-center transition">
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.m4a,.webm,.ogg,.aac"
          className="hidden"
          onChange={(e) => handleFileSelect(e.target.files)}
          disabled={uploading}
        />
        <div className="space-y-2">
          <div className="mx-auto w-10 h-10 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-lg">
            📞
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-900">
              Upload HR Phone Screening Recording
            </p>
            <p className="text-xs text-zinc-500">
              Upload initial HR phone screening audio (.mp3, .wav, .m4a, .webm). AI will automatically
              transcribe, evaluate basic communication & background, and generate recommended focus areas for the L1 Technical Interview.
            </p>
          </div>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="btn-primary text-xs px-3 py-1.5 inline-flex items-center gap-1.5 shadow-sm"
          >
            {uploading ? (
              <>
                <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                Transcribing & Analyzing Call…
              </>
            ) : (
              "Select Audio File to Analyze"
            )}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-xs p-2.5 rounded">
          {error}
        </div>
      )}

      {loading && <p className="text-xs text-zinc-400">Loading screening records…</p>}

      {/* Screenings Selector if multiple exist */}
      {screenings.length > 1 && (
        <div className="flex gap-2 items-center text-xs overflow-x-auto pb-1">
          <span className="text-zinc-500 shrink-0">Recorded Calls:</span>
          {screenings.map((s, idx) => (
            <button
              key={s.id}
              onClick={() => setActiveScreening(s)}
              className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${
                activeScreening?.id === s.id
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-100 hover:bg-zinc-200 text-zinc-700"
              }`}
            >
              Call #{screenings.length - idx}{" "}
              {s.created_at && `· ${new Date(s.created_at).toLocaleDateString()}`}
            </button>
          ))}
        </div>
      )}

      {/* Active Screening Details */}
      {activeScreening && (
        <div className="border border-zinc-200 rounded-lg p-4 bg-white space-y-4 shadow-sm">
          {/* Header & Verdict */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 pb-3">
            <div>
              <div className="flex items-center gap-2">
                <span
                  className={`px-2.5 py-0.5 rounded-full text-xs font-bold border ${
                    VERDICT_STYLES[activeScreening.verdict]?.bg ?? "bg-zinc-100"
                  } ${VERDICT_STYLES[activeScreening.verdict]?.text ?? "text-zinc-800"} ${
                    VERDICT_STYLES[activeScreening.verdict]?.border ?? "border-zinc-300"
                  }`}
                >
                  {VERDICT_STYLES[activeScreening.verdict]?.label ?? activeScreening.verdict}
                </span>
                <span className="text-xs text-zinc-500">
                  Duration:{" "}
                  {activeScreening.audio_duration_seconds
                    ? `${Math.floor(activeScreening.audio_duration_seconds / 60)}m ${Math.round(
                        activeScreening.audio_duration_seconds % 60
                      )}s`
                    : "Recorded call"}
                </span>
              </div>
            </div>

            {/* Audio Stream Player */}
            {activeScreening.audio_file_path && (
              <div className="flex items-center gap-2">
                <audio
                  ref={audioRef}
                  controls
                  src={`${BASE_URL}/l1-screening/${activeScreening.id}/audio`}
                  className="h-8 max-w-[280px]"
                />
              </div>
            )}
          </div>

          {/* Scores Breakdown */}
          <div className="grid grid-cols-3 gap-3">
            <div className="border border-zinc-200 bg-zinc-50/70 rounded-md p-2.5 text-center">
              <p className="text-[11px] text-zinc-500 font-medium">HR Screening Fit</p>
              <p className="text-xl font-bold text-zinc-900 mt-0.5">
                {activeScreening.overall_l1_score !== null
                  ? `${activeScreening.overall_l1_score.toFixed(0)}/100`
                  : "—"}
              </p>
            </div>
            <div className="border border-blue-200 bg-blue-50/40 rounded-md p-2.5 text-center">
              <p className="text-[11px] text-blue-700 font-medium">Technical Clarity</p>
              <p className="text-xl font-bold text-blue-950 mt-0.5">
                {activeScreening.technical_score !== null
                  ? `${activeScreening.technical_score.toFixed(0)}/100`
                  : "—"}
              </p>
            </div>
            <div className="border border-purple-200 bg-purple-50/40 rounded-md p-2.5 text-center">
              <p className="text-[11px] text-purple-700 font-medium">Verbal Fluency</p>
              <p className="text-xl font-bold text-purple-950 mt-0.5">
                {activeScreening.communication_score !== null
                  ? `${activeScreening.communication_score.toFixed(0)}/100`
                  : "—"}
              </p>
            </div>
          </div>

          {/* Acoustic Vocal Tone Badge if available */}
          {activeScreening.voice_tone_notes && activeScreening.voice_tone_notes.overall_tone && (
            <div className="text-xs text-zinc-600 bg-zinc-50 border border-zinc-200 rounded p-2 flex items-center justify-between">
              <span>
                <strong className="text-zinc-800">Vocal Tone & Demeanor:</strong>{" "}
                <span className="capitalize">{activeScreening.voice_tone_notes.overall_tone}</span>{" "}
                (Confidence: {activeScreening.voice_tone_notes.confidence_level})
              </span>
              {activeScreening.voice_tone_notes.notes && (
                <span className="text-[11px] text-zinc-500 italic max-w-xs truncate">
                  {activeScreening.voice_tone_notes.notes}
                </span>
              )}
            </div>
          )}

          {/* Executive Call Summary */}
          {activeScreening.call_summary && (
            <div>
              <h4 className="text-xs font-semibold text-zinc-800 uppercase tracking-wide mb-1">
                Executive Call Summary
              </h4>
              <p className="text-xs text-zinc-700 leading-relaxed bg-zinc-50/50 p-2.5 rounded border border-zinc-100 whitespace-pre-line">
                {activeScreening.call_summary}
              </p>
            </div>
          )}

          {/* Extracted Logistics & Facts */}
          {activeScreening.extracted_details &&
            Object.keys(activeScreening.extracted_details).length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-zinc-800 uppercase tracking-wide mb-1.5">
                  Screening Logistics & Key Facts
                </h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                  {Object.entries(activeScreening.extracted_details).map(([k, v]) => {
                    if (!v) return null;
                    const label = k
                      .replace(/_/g, " ")
                      .replace(/discussed/g, "")
                      .trim();
                    return (
                      <div key={k} className="border border-zinc-100 bg-zinc-50 p-2 rounded">
                        <span className="text-zinc-500 block capitalize text-[10px]">{label}:</span>
                        <span className="font-medium text-zinc-800 text-xs">{v}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

          {/* Strengths & Red Flags */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {activeScreening.strengths && activeScreening.strengths.length > 0 && (
              <div className="border border-emerald-200 bg-emerald-50/30 p-2.5 rounded-md text-xs">
                <h4 className="font-semibold text-emerald-900 mb-1 flex items-center gap-1">
                  ✓ Strengths Observed
                </h4>
                <ul className="list-disc list-inside text-emerald-800 space-y-0.5">
                  {activeScreening.strengths.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}

            {activeScreening.red_flags && activeScreening.red_flags.length > 0 && (
              <div className="border border-red-200 bg-red-50/30 p-2.5 rounded-md text-xs">
                <h4 className="font-semibold text-red-900 mb-1 flex items-center gap-1">
                  ⚠ Red Flags / Concerns
                </h4>
                <ul className="list-disc list-inside text-red-800 space-y-0.5">
                  {activeScreening.red_flags.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Actionable Next Steps */}
          {activeScreening.next_steps && activeScreening.next_steps.length > 0 && (
            <div className="border border-blue-200 bg-blue-50/40 p-3 rounded-md text-xs">
              <h4 className="font-semibold text-blue-950 mb-1.5 flex items-center gap-1">
                🎯 Next Steps for L1 Technical Interviewer ({candidateName})
              </h4>
              <ul className="space-y-1 text-blue-900">
                {activeScreening.next_steps.map((step, idx) => (
                  <li key={idx} className="flex items-start gap-1.5">
                    <span className="font-bold text-blue-600">•</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Interactive Synchronized Transcript */}
          {activeScreening.transcript && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <h4 className="text-xs font-semibold text-zinc-800 uppercase tracking-wide">
                  Screening Call Transcript
                </h4>
                <span className="text-[10px] text-zinc-400 italic">
                  * Speaker turns are AI-inferred from context
                </span>
              </div>
              <div className="border border-zinc-200 rounded-md p-3 max-h-56 overflow-y-auto space-y-2 text-xs bg-zinc-50/30">
                {activeScreening.transcript_segments &&
                activeScreening.transcript_segments.length > 0 ? (
                  activeScreening.transcript_segments.map((seg, idx) => (
                    <div
                      key={idx}
                      onClick={() => handleSeek(seg.start)}
                      className="hover:bg-blue-50/60 p-1 rounded cursor-pointer transition flex items-start gap-2 group"
                    >
                      <span className="text-[10px] font-mono text-zinc-400 group-hover:text-blue-600 shrink-0">
                        [{Math.floor(seg.start / 60)}:
                        {String(Math.floor(seg.start % 60)).padStart(2, "0")}]
                      </span>
                      <p className="text-zinc-700 leading-relaxed">{seg.text}</p>
                    </div>
                  ))
                ) : (
                  <p className="text-zinc-700 leading-relaxed whitespace-pre-line">
                    {activeScreening.transcript}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
