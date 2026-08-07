import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// MediaPipe's WASM runtime logs its own benign INFO-level startup messages (e.g. "Created
// TensorFlow Lite XNNPACK delegate for CPU") through console.error internally — not our
// code's choice, a quirk of that library. Next's dev overlay treats every console.error as
// a blocking error, so without this filter a completely successful init looks like a crash.
// Narrowly matched to this one known message pattern — every other console.error still
// reaches the overlay normally.
if (typeof window !== "undefined") {
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string" && /TensorFlow Lite|XNNPACK delegate/.test(first)) {
      return;
    }
    originalConsoleError(...args);
  };
}

// Model + WASM runtime are self-hosted under /public (models/, wasm/) rather than pulled
// from Google's CDN at runtime — one less external dependency for this to silently break on.
const WASM_PATH = "/wasm";
const MODEL_PATH = "/models/face_landmarker.task";

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

function getFaceLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = FilesetResolver.forVisionTasks(WASM_PATH).then((fileset) =>
      FaceLandmarker.createFromOptions(fileset, {
        // CPU, not GPU: this runs alongside a live Jitsi call and the MediaRecorder's own
        // video encoding, both already using the GPU — adding a GPU-delegated inference
        // graph on top is a real source of contention/instability. Slower, but this only
        // needs to run a few times a second, not every frame.
        baseOptions: { modelAssetPath: MODEL_PATH, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 2,
      })
    );
  }
  return landmarkerPromise;
}

export interface FaceSignalResult {
  faceCount: number;
  gazeOffScreen: boolean;
  excessiveMotion: boolean;
}

// Landmark indices from MediaPipe's 468-point face mesh: nose tip and the two outer eye
// corners. Using relative landmark positions (all in normalized 0-1 image coordinates)
// instead of decoding the transformation matrix's rotation convention — simpler to get
// right and easy to sanity-check by inspection.
const NOSE_TIP = 1;
const RIGHT_EYE_OUTER = 33;
const LEFT_EYE_OUTER = 263;

const YAW_RATIO_THRESHOLD = 0.35;
const MOTION_RATIO_THRESHOLD = 0.12;

export function createFaceSignalDetector() {
  let lastNose: { x: number; y: number } | null = null;
  let busy = false;

  return async function detect(video: HTMLVideoElement): Promise<FaceSignalResult | null> {
    if (video.readyState < 2 || busy) return null;

    let landmarker: FaceLandmarker;
    try {
      landmarker = await getFaceLandmarker();
    } catch {
      return null; // model/WASM failed to load — not treated as a hard requirement
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
        lastNose = null;
        return { faceCount: 0, gazeOffScreen: true, excessiveMotion: false };
      }

      const landmarks = faces[0];
      const nose = landmarks[NOSE_TIP];
      const rightEye = landmarks[RIGHT_EYE_OUTER];
      const leftEye = landmarks[LEFT_EYE_OUTER];
      const eyeDist = Math.hypot(leftEye.x - rightEye.x, leftEye.y - rightEye.y) || 1;
      const midX = (leftEye.x + rightEye.x) / 2;
      const yawRatio = Math.abs(nose.x - midX) / eyeDist;

      let excessiveMotion = false;
      if (lastNose) {
        const motionRatio = Math.hypot(nose.x - lastNose.x, nose.y - lastNose.y) / eyeDist;
        excessiveMotion = motionRatio > MOTION_RATIO_THRESHOLD;
      }
      lastNose = { x: nose.x, y: nose.y };

      return {
        faceCount: faces.length,
        gazeOffScreen: yawRatio > YAW_RATIO_THRESHOLD,
        excessiveMotion,
      };
    } finally {
      busy = false;
    }
  };
}
