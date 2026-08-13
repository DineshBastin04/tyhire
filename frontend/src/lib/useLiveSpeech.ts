"use client";

import { useEffect, useState } from "react";
import { postForm } from "@/lib/api";

export interface LiveTranscriptItem {
  id: string;
  speaker: "candidate" | "interviewer";
  text: string;
  offsetMs: number;
  timestamp: string;
  isInterim?: boolean;
}

// A few seconds is the sweet spot: long enough that most single utterances land in one
// chunk (fewer split-across-chunks transcripts), short enough that "live" still feels live.
const CHUNK_DURATION_MS = 6000;
// Brief pause between stopping one recorder and starting the next — gives the browser a
// tick to actually flush the previous MediaRecorder before reusing the same audio track.
const RESTART_DELAY_MS = 300;

/**
 * Records short, independent audio chunks and uploads each to the backend for server-side
 * transcription (see live-transcript-chunk / interviewer-live-transcript-chunk in
 * interviews.py) — a browser-agnostic replacement for the browser's own SpeechRecognition
 * API, which only ever existed in Chromium browsers and was known to silently stop or drop
 * results even there. Trades true word-by-word captions for a few seconds of latency
 * (chunk length + upload + transcription) in exchange for working identically everywhere
 * MediaRecorder does — which is every modern browser.
 *
 * Requests its own microphone stream independently of whatever else on the page is already
 * capturing audio (the main interview recording, WebRTC) — getUserMedia supports multiple
 * concurrent captures from the same device fine, and keeping this self-contained means it
 * doesn't need to know about or share state with those other, unrelated capture paths.
 */
export function useLiveSpeech({
  sessionId,
  speaker,
  enabled,
  startedAtMs,
  authToken,
  tokenHeaderKey,
}: {
  sessionId?: string;
  speaker: "candidate" | "interviewer";
  enabled: boolean;
  startedAtMs?: number;
  authToken?: string;
  tokenHeaderKey?: string;
}) {
  const [liveItems, setLiveItems] = useState<LiveTranscriptItem[]>([]);
  const [isCapturing, setIsCapturing] = useState(false);

  useEffect(() => {
    if (!enabled || !sessionId) return;

    let cancelled = false;
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;

    const endpoint =
      speaker === "interviewer"
        ? `/interviews/${sessionId}/interviewer-live-transcript-chunk`
        : `/interviews/${sessionId}/live-transcript-chunk`;
    const headers = authToken && tokenHeaderKey ? { [tokenHeaderKey]: authToken } : undefined;

    function uploadChunk(blob: Blob, offsetMs: number) {
      if (blob.size === 0) return;
      const form = new FormData();
      form.append("clip", blob, "chunk.webm");
      form.append("session_offset_ms", String(offsetMs));
      // Best-effort — a dropped chunk just doesn't appear live, same as a missed browser
      // SpeechRecognition result would have. The final post-call transcript (from the main
      // recording) is unaffected either way.
      postForm(endpoint, form, headers).catch(() => {});
    }

    function recordOneChunk() {
      if (cancelled || !stream) return;
      const chunkOffsetMs = startedAtMs ? Date.now() - startedAtMs : 0;
      const chunks: Blob[] = [];

      try {
        recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      } catch {
        return;
      }
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        setIsCapturing(false);
        uploadChunk(new Blob(chunks, { type: "audio/webm" }), chunkOffsetMs);
        if (!cancelled) restartTimer = setTimeout(recordOneChunk, RESTART_DELAY_MS);
      };
      recorder.start();
      setIsCapturing(true);
      stopTimer = setTimeout(() => {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      }, CHUNK_DURATION_MS);
    }

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        recordOneChunk();
      })
      .catch(() => {
        // No mic access for this capture — the live transcript for this speaker just won't
        // populate. Every other feature (main recording, signals) requests its own mic
        // access separately and isn't affected by this failing.
      });

    return () => {
      cancelled = true;
      clearTimeout(stopTimer);
      clearTimeout(restartTimer);
      if (recorder && recorder.state !== "inactive") recorder.stop();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [enabled, sessionId, speaker, startedAtMs, authToken, tokenHeaderKey]);

  return { liveItems, isCapturing, setLiveItems };
}
