import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM_PATH = "/wasm";
const MODEL_PATH = "/models/face_landmarker.task";

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

export function getFaceLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = FilesetResolver.forVisionTasks(WASM_PATH).then((fileset) =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 2,
      })
    );
  }
  return landmarkerPromise;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EyeGazeTrackingResult {
  faceDetected: boolean;
  faceCount: number;
  isLookingAtCamera: boolean;
  teleprompterReading: boolean;
  teleprompterConfidence: number;
  gazeStatus: "focused" | "turned_away" | "teleprompter_reading" | "no_face";
  gazeLabel: string;
  leftEyeBox: Box | null;
  rightEyeBox: Box | null;
  faceBox: Box | null;
  yawRatio: number;
  pitchRatio: number;
}

// MediaPipe 468 landmark indices
const NOSE_TIP = 1;
const RIGHT_EYE_INDICES = [33, 133, 158, 159, 160, 144, 145, 153];
const LEFT_EYE_INDICES = [263, 362, 385, 386, 387, 373, 374, 380];
const RIGHT_EYE_OUTER = 33;
const LEFT_EYE_OUTER = 263;
const LEFT_IRIS_CENTER = 468;
const RIGHT_IRIS_CENTER = 473;

function computeBox(
  landmarks: { x: number; y: number }[],
  indices: number[],
  padX = 0.025,
  padY = 0.025
): Box {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const idx of indices) {
    const pt = landmarks[idx];
    if (!pt) continue;
    if (pt.x < minX) minX = pt.x;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.y > maxY) maxY = pt.y;
  }

  const width = Math.max(0.02, maxX - minX + padX * 2);
  const height = Math.max(0.02, maxY - minY + padY * 2);
  const x = Math.max(0, minX - padX);
  const y = Math.max(0, minY - padY);

  return { x, y, width, height };
}

export function createEyeGazeTracker() {
  let busy = false;
  const irisHistory: { time: number; irisRatio: number; yaw: number }[] = [];

  return async function track(video: HTMLVideoElement): Promise<EyeGazeTrackingResult | null> {
    if (video.readyState < 2 || busy) return null;

    let landmarker: FaceLandmarker;
    try {
      landmarker = await getFaceLandmarker();
    } catch {
      return null;
    }

    busy = true;
    try {
      let result;
      try {
        result = landmarker.detectForVideo(video, performance.now());
      } catch {
        return null;
      }

      const faces = result.faceLandmarks ?? [];
      if (faces.length === 0) {
        return {
          faceDetected: false,
          faceCount: 0,
          isLookingAtCamera: false,
          teleprompterReading: false,
          teleprompterConfidence: 0,
          gazeStatus: "no_face",
          gazeLabel: "No Face Detected",
          leftEyeBox: null,
          rightEyeBox: null,
          faceBox: null,
          yawRatio: 0,
          pitchRatio: 0,
        };
      }

      const landmarks = faces[0];
      const nose = landmarks[NOSE_TIP];
      const rightEye = landmarks[RIGHT_EYE_OUTER];
      const leftEye = landmarks[LEFT_EYE_OUTER];

      const eyeDist = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y) || 0.1;
      const midEyeX = (leftEye.x + rightEye.x) / 2;
      const midEyeY = (leftEye.y + rightEye.y) / 2;

      const yawRatio = Math.abs(nose.x - midEyeX) / eyeDist;
      const pitchRatio = (nose.y - midEyeY) / eyeDist;

      // Looking at camera when yaw offset is low and pitch is within natural eye level
      const isLookingAtCamera = yawRatio <= 0.32 && pitchRatio >= 0.12 && pitchRatio <= 0.70;

      // Iris relative horizontal position within left eye
      const leftEyeInner = landmarks[362] || landmarks[133];
      const leftEyeOuter = landmarks[263] || landmarks[33];
      const irisPt = landmarks[LEFT_IRIS_CENTER] || landmarks[RIGHT_IRIS_CENTER] || landmarks[33];
      const eyeSpan = Math.abs(leftEyeOuter.x - leftEyeInner.x) || 0.05;
      const irisRatio = (irisPt.x - Math.min(leftEyeInner.x, leftEyeOuter.x)) / eyeSpan;

      const now = performance.now();
      irisHistory.push({ time: now, irisRatio, yaw: yawRatio });
      // Keep ~4 seconds rolling window
      while (irisHistory.length > 0 && now - irisHistory[0].time > 4000) {
        irisHistory.shift();
      }

      // Teleprompter / Script-Reading Heuristic:
      // Counts horizontal reading sweep cycles: progressive drift followed by rapid saccade reset
      let sweepCycles = 0;
      let inSweep = false;
      let sweepLength = 0;

      if (irisHistory.length >= 10) {
        for (let i = 1; i < irisHistory.length; i++) {
          const delta = irisHistory[i].irisRatio - irisHistory[i - 1].irisRatio;
          if (delta > 0.015) {
            inSweep = true;
            sweepLength++;
          } else if (delta < -0.04 && inSweep && sweepLength >= 3) {
            // Sharp saccadic jump back to start of line
            sweepCycles++;
            inSweep = false;
            sweepLength = 0;
          }
        }
      }

      // 2 or more horizontal sweep-and-snap cycles in 4s while head is relatively stationary indicates reading a teleprompter
      const teleprompterReading = sweepCycles >= 2 && yawRatio < 0.28;
      const teleprompterConfidence = teleprompterReading ? Math.min(0.95, 0.65 + sweepCycles * 0.1) : 0;

      // Extract left & right eye bounding boxes with appropriate padding
      const rightEyeBox = computeBox(landmarks, RIGHT_EYE_INDICES, 0.015, 0.018);
      const leftEyeBox = computeBox(landmarks, LEFT_EYE_INDICES, 0.015, 0.018);

      // Compute face bounding box
      let minFx = Infinity, maxFx = -Infinity, minFy = Infinity, maxFy = -Infinity;
      for (const pt of landmarks) {
        if (pt.x < minFx) minFx = pt.x;
        if (pt.x > maxFx) maxFx = pt.x;
        if (pt.y < minFy) minFy = pt.y;
        if (pt.y > maxFy) maxFy = pt.y;
      }
      const faceBox: Box = {
        x: Math.max(0, minFx - 0.02),
        y: Math.max(0, minFy - 0.03),
        width: Math.min(1, maxFx - minFx + 0.04),
        height: Math.min(1, maxFy - minFy + 0.06),
      };

      let gazeStatus: "focused" | "turned_away" | "teleprompter_reading" | "no_face" = isLookingAtCamera
        ? "focused"
        : "turned_away";
      let gazeLabel = isLookingAtCamera ? "Focused on Camera" : "Turned Away / Looking Off-Screen";

      if (teleprompterReading) {
        gazeStatus = "teleprompter_reading";
        gazeLabel = `⚠️ Teleprompter Script Reading (${Math.round(teleprompterConfidence * 100)}%)`;
      }

      return {
        faceDetected: true,
        faceCount: faces.length,
        isLookingAtCamera,
        teleprompterReading,
        teleprompterConfidence,
        gazeStatus,
        gazeLabel,
        leftEyeBox,
        rightEyeBox,
        faceBox,
        yawRatio,
        pitchRatio,
      };
    } finally {
      busy = false;
    }
  };
}
