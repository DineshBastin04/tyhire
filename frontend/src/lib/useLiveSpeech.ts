"use client";

import { useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/api";

export interface LiveTranscriptItem {
  id: string;
  speaker: "candidate" | "interviewer";
  text: string;
  offsetMs: number;
  timestamp: string;
  isInterim?: boolean;
}

// Browser Web Speech API type declaration
interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      [index: number]: {
        transcript: string;
        confidence: number;
      };
    };
  };
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
}

interface WindowWithSpeech extends Window {
  SpeechRecognition?: { new (): SpeechRecognitionLike };
  webkitSpeechRecognition?: { new (): SpeechRecognitionLike };
}

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
  const [currentInterim, setCurrentInterim] = useState<string>("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    const win = window as unknown as WindowWithSpeech;
    const SpeechConstructor = win.SpeechRecognition || win.webkitSpeechRecognition;

    if (!SpeechConstructor) {
      console.warn("Web Speech API not supported in this browser.");
      return;
    }

    let isRunning = true;
    let recognition: SpeechRecognitionLike;

    try {
      recognition = new SpeechConstructor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognitionRef.current = recognition;
    } catch (e) {
      console.warn("Failed to initialize speech recognition", e);
      return;
    }

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript?.trim();
        if (!text) continue;

        if (result.isFinal) {
          const offsetMs = startedAtMs ? Date.now() - startedAtMs : 0;
          const newItem: LiveTranscriptItem = {
            id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            speaker,
            text,
            offsetMs,
            timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
            isFinal: true,
          } as LiveTranscriptItem;

          setLiveItems((prev) => [...prev, newItem]);
          setCurrentInterim("");

          // Post to backend live-transcript buffer
          if (sessionId) {
            const headers = authToken && tokenHeaderKey ? { [tokenHeaderKey]: authToken } : undefined;
            postJson(`/interviews/${sessionId}/live-transcript`, {
              speaker,
              text,
              offset_ms: offsetMs,
            }, headers).catch(() => {});
          }
        } else {
          interim += text + " ";
        }
      }
      setCurrentInterim(interim.trim());
    };

    recognition.onerror = () => {
      // Speech recognition encountered error or silence; onend will restart if isRunning
    };

    recognition.onend = () => {
      if (isRunning) {
        try {
          recognition.start();
        } catch {
          // Restart after short tick
          setTimeout(() => {
            if (isRunning) {
              try {
                recognition.start();
              } catch {}
            }
          }, 300);
        }
      }
    };

    try {
      recognition.start();
    } catch {}

    return () => {
      isRunning = false;
      try {
        recognition.stop();
      } catch {}
    };
  }, [enabled, sessionId, speaker, startedAtMs, authToken, tokenHeaderKey]);

  return { liveItems, currentInterim, setLiveItems };
}
