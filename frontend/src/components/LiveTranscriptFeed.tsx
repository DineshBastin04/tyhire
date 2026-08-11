"use client";

import { useEffect, useRef } from "react";
import type { LiveTranscriptItem } from "@/lib/useLiveSpeech";

interface LiveTranscriptFeedProps {
  items: LiveTranscriptItem[];
  currentInterim?: string;
  interviewerInterim?: string;
  className?: string;
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function LiveTranscriptFeed({
  items,
  currentInterim = "",
  interviewerInterim = "",
  className = "",
}: LiveTranscriptFeedProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items, currentInterim, interviewerInterim]);

  return (
    <div className={`flex flex-col bg-zinc-900 border border-zinc-800 rounded-lg p-3 text-sm text-zinc-100 ${className}`}>
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-800">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </span>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">Live Transcription Stream</h3>
        </div>
        <span className="text-[11px] text-zinc-400 font-mono">Real-time STT</span>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2.5 max-h-[300px] pr-1">
        {items.length === 0 && !currentInterim && !interviewerInterim ? (
          <div className="flex flex-col items-center justify-center py-8 text-center text-zinc-500">
            <p className="text-xs">🎙️ Listening to conversation...</p>
            <p className="text-[11px] text-zinc-600 mt-1">Transcripts will appear here live as words are spoken.</p>
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              className={`p-2 rounded-md text-xs border ${
                item.speaker === "candidate"
                  ? "bg-blue-950/40 border-blue-800/40 text-blue-100"
                  : "bg-purple-950/40 border-purple-800/40 text-purple-100"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span
                  className={`font-semibold uppercase text-[10px] px-1.5 py-0.5 rounded ${
                    item.speaker === "candidate"
                      ? "bg-blue-600 text-white"
                      : "bg-purple-600 text-white"
                  }`}
                >
                  {item.speaker === "candidate" ? "Candidate" : "Interviewer"}
                </span>
                <span className="text-[10px] text-zinc-400 font-mono">{formatOffset(item.offsetMs)}</span>
              </div>
              <p className="leading-relaxed whitespace-pre-wrap">{item.text}</p>
            </div>
          ))
        )}

        {currentInterim && (
          <div className="p-2 rounded-md text-xs bg-blue-950/20 border border-blue-700/30 text-blue-200 animate-pulse">
            <span className="font-semibold uppercase text-[10px] px-1.5 py-0.5 rounded bg-blue-700/60 text-white mr-1.5">
              Candidate speaking...
            </span>
            <span className="italic">{currentInterim}</span>
          </div>
        )}

        {interviewerInterim && (
          <div className="p-2 rounded-md text-xs bg-purple-950/20 border border-purple-700/30 text-purple-200 animate-pulse">
            <span className="font-semibold uppercase text-[10px] px-1.5 py-0.5 rounded bg-purple-700/60 text-white mr-1.5">
              You speaking...
            </span>
            <span className="italic">{interviewerInterim}</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
