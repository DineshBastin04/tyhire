"use client";

import { useEffect, useState } from "react";
import { createEyeGazeTracker, type EyeGazeTrackingResult } from "@/lib/eyeGazeTracker";

interface EyeTrackingOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mirrored?: boolean;
  objectFit?: "contain" | "cover";
  onGazeChange?: (isFocused: boolean, isTeleprompter?: boolean) => void;
  showHudBadge?: boolean;
}

export default function EyeTrackingOverlay({
  videoRef,
  onGazeChange,
  showHudBadge = false,
}: EyeTrackingOverlayProps) {
  const [gazeState, setGazeState] = useState<EyeGazeTrackingResult | null>(null);

  useEffect(() => {
    const tracker = createEyeGazeTracker();
    let isCancelled = false;
    let animFrame: number;
    let lastTrackTime = 0;
    const TRACK_INTERVAL_MS = 150;

    async function loop(time: number) {
      if (isCancelled) return;

      const video = videoRef.current;
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        if (time - lastTrackTime >= TRACK_INTERVAL_MS) {
          lastTrackTime = time;
          try {
            const result = await tracker(video);
            if (!isCancelled && result) {
              setGazeState(result);
              onGazeChange?.(result.isLookingAtCamera, result.teleprompterReading);
            }
          } catch {
            // Ignore frame blips
          }
        }
      }

      animFrame = requestAnimationFrame(loop);
    }

    animFrame = requestAnimationFrame(loop);

    return () => {
      isCancelled = true;
      cancelAnimationFrame(animFrame);
    };
  }, [videoRef, onGazeChange]);

  if (!showHudBadge || !gazeState || !gazeState.faceDetected) return null;

  return (
    <div className="absolute top-2 left-2 pointer-events-none flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold backdrop-blur-md bg-white/95 shadow-md border border-zinc-200 transition-all duration-300 z-10">
      <span
        className={`w-2.5 h-2.5 rounded-full ${
          gazeState.teleprompterReading
            ? "bg-purple-600 animate-pulse shadow-[0_0_8px_#9333ea]"
            : gazeState.isLookingAtCamera
            ? "bg-emerald-500 shadow-[0_0_6px_#10b981]"
            : "bg-red-500 animate-pulse shadow-[0_0_6px_#ef4444]"
        }`}
      />
      <span
        className={
          gazeState.teleprompterReading
            ? "text-purple-700 font-bold"
            : gazeState.isLookingAtCamera
            ? "text-emerald-700"
            : "text-red-600 font-bold"
        }
      >
        {gazeState.teleprompterReading
          ? `⚠️ Teleprompter Script Reading (${Math.round(gazeState.teleprompterConfidence * 100)}%)`
          : gazeState.isLookingAtCamera
          ? "Gaze: Focused on Camera"
          : "Gaze: Looking Away"}
      </span>
    </div>
  );
}
