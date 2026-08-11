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
  gazeStatus: "focused" | "turned_away" | "no_face";
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

      return {
        faceDetected: true,
        faceCount: faces.length,
        isLookingAtCamera,
        gazeStatus: isLookingAtCamera ? "focused" : "turned_away",
        gazeLabel: isLookingAtCamera ? "Focused on Camera" : "Turned Away / Looking Off-Screen",
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
