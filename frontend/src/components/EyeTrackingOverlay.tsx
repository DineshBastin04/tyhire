"use client";

import { useEffect, useRef, useState } from "react";
import { createEyeGazeTracker, type EyeGazeTrackingResult } from "@/lib/eyeGazeTracker";

interface EyeTrackingOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  mirrored?: boolean;
  onGazeChange?: (isFocused: boolean, isTeleprompter?: boolean) => void;
  showHudBadge?: boolean;
}

export default function EyeTrackingOverlay({
  videoRef,
  mirrored = false,
  onGazeChange,
  showHudBadge = true,
}: EyeTrackingOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [gazeState, setGazeState] = useState<EyeGazeTrackingResult | null>(null);
  const onGazeChangeRef = useRef(onGazeChange);
  onGazeChangeRef.current = onGazeChange;

  useEffect(() => {
    const tracker = createEyeGazeTracker();
    let isCancelled = false;
    let animFrame: number;
    let lastTrackTime = 0;
    const TRACK_INTERVAL_MS = 140; // ~7 fps

    async function loop(time: number) {
      if (isCancelled) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (video && canvas && video.readyState >= 2 && video.videoWidth > 0) {
        const rect = video.getBoundingClientRect();
        if (canvas.width !== rect.width || canvas.height !== rect.height) {
          canvas.width = rect.width;
          canvas.height = rect.height;
        }

        if (time - lastTrackTime >= TRACK_INTERVAL_MS) {
          lastTrackTime = time;
          try {
            const result = await tracker(video);
            if (!isCancelled && result) {
              setGazeState(result);
              onGazeChangeRef.current?.(result.isLookingAtCamera, result.teleprompterReading);
            }
          } catch {
            // Ignore frame blip
          }
        }

        // Render visual canvas overlay
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);

          if (gazeState && gazeState.faceDetected) {
            const isFocused = gazeState.isLookingAtCamera;
            const isTeleprompter = gazeState.teleprompterReading;

            // Color scheme: Green = focused, Purple = teleprompter script reading, Red = looking away
            let primaryColor = isFocused ? "#22c55e" : "#ef4444";
            let shadowColor = isFocused ? "rgba(34, 197, 94, 0.6)" : "rgba(239, 68, 68, 0.7)";
            let fillBg = isFocused ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.18)";

            if (isTeleprompter) {
              primaryColor = "#c084fc"; // Purple accent
              shadowColor = "rgba(192, 132, 252, 0.8)";
              fillBg = "rgba(168, 85, 247, 0.22)";
            }

            const drawBox = (box: { x: number; y: number; width: number; height: number }, label: string) => {
              let drawX = box.x * canvas.width;
              if (mirrored) {
                drawX = (1 - (box.x + box.width)) * canvas.width;
              }
              const drawY = box.y * canvas.height;
              const drawW = box.width * canvas.width;
              const drawH = box.height * canvas.height;

              ctx.save();
              ctx.shadowColor = shadowColor;
              ctx.shadowBlur = 8;
              ctx.fillStyle = fillBg;
              ctx.fillRect(drawX, drawY, drawW, drawH);

              ctx.strokeStyle = primaryColor;
              ctx.lineWidth = 2.2;
              ctx.strokeRect(drawX, drawY, drawW, drawH);

              // Corner brackets
              const cornerLen = Math.min(8, drawW / 3, drawH / 3);
              ctx.lineWidth = 3.5;
              // Top-left
              ctx.beginPath();
              ctx.moveTo(drawX, drawY + cornerLen);
              ctx.lineTo(drawX, drawY);
              ctx.lineTo(drawX + cornerLen, drawY);
              ctx.stroke();

              // Top-right
              ctx.beginPath();
              ctx.moveTo(drawX + drawW - cornerLen, drawY);
              ctx.lineTo(drawX + drawW, drawY);
              ctx.lineTo(drawX + drawW, drawY + cornerLen);
              ctx.stroke();

              // Bottom-left
              ctx.beginPath();
              ctx.moveTo(drawX, drawY + drawH - cornerLen);
              ctx.lineTo(drawX, drawY + drawH);
              ctx.lineTo(drawX + cornerLen, drawY + drawH);
              ctx.stroke();

              // Bottom-right
              ctx.beginPath();
              ctx.moveTo(drawX + drawW - cornerLen, drawY + drawH);
              ctx.lineTo(drawX + drawW, drawY + drawH);
              ctx.lineTo(drawX + drawW, drawY + drawH - cornerLen);
              ctx.stroke();

              // Label tag
              ctx.shadowBlur = 0;
              ctx.fillStyle = primaryColor;
              ctx.font = "bold 10px sans-serif";
              const tagW = ctx.measureText(label).width + 8;
              ctx.fillRect(drawX, Math.max(0, drawY - 14), tagW, 14);
              ctx.fillStyle = "#ffffff";
              ctx.fillText(label, drawX + 4, Math.max(10, drawY - 3));
              ctx.restore();
            };

            if (gazeState.leftEyeBox) drawBox(gazeState.leftEyeBox, "Eye L");
            if (gazeState.rightEyeBox) drawBox(gazeState.rightEyeBox, "Eye R");
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
  }, [videoRef, mirrored, gazeState]);

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden rounded-md z-10">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      {showHudBadge && gazeState && gazeState.faceDetected && (
        <div className="absolute top-2 left-2 pointer-events-none flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold backdrop-blur-md bg-black/75 shadow-lg border border-white/15 transition-all duration-300">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              gazeState.teleprompterReading
                ? "bg-purple-400 animate-pulse shadow-[0_0_10px_#c084fc]"
                : gazeState.isLookingAtCamera
                ? "bg-green-500 shadow-[0_0_8px_#22c55e]"
                : "bg-red-500 animate-pulse shadow-[0_0_8px_#ef4444]"
            }`}
          />
          <span
            className={
              gazeState.teleprompterReading
                ? "text-purple-300 font-bold"
                : gazeState.isLookingAtCamera
                ? "text-green-300"
                : "text-red-300 font-bold"
            }
          >
            {gazeState.teleprompterReading
              ? `⚠️ Teleprompter Script Reading (${Math.round(gazeState.teleprompterConfidence * 100)}%)`
              : gazeState.isLookingAtCamera
              ? "Eye Focus: On Camera (Looking Forward)"
              : "Eye Focus: Turned Away from Camera"}
          </span>
        </div>
      )}
    </div>
  );
}
