export type JobLevel = "fresher" | "experienced";
export type WorkMode = "remote" | "hybrid" | "onsite";
export type Bucket = "approved" | "review" | "declined";

export interface HrUser {
  id: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
  is_admin: boolean;
}

export interface Job {
  id: string;
  title: string;
  jd_text: string;
  required_skills: string[];
  level: JobLevel;
  work_mode: WorkMode;
  min_years_experience: number | null;
  allowed_locations: string[];
  max_notice_period_days: number | null;
  salary_band_min: number | null;
  salary_band_max: number | null;
  approve_threshold: number;
  decline_threshold: number;
  weight_skills: number;
  weight_experience: number;
  weight_education: number;
  weight_certifications: number;
  require_desktop_probe: boolean;
  archived: boolean;
  archived_reason: string | null;
}

export interface ScoreCategory {
  score: number;
  reasons: string[];
}

export interface ScoreBreakdown {
  skills: ScoreCategory;
  experience: ScoreCategory;
  education: ScoreCategory;
  certifications: ScoreCategory;
}

export interface Candidate {
  id: string;
  job_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  parsed_profile: Record<string, unknown> | null;
  notice_period_days: number | null;
  expected_salary: number | null;
  ocr_fallback_used: boolean;
  is_duplicate_of: string | null;
  knockout_failed: boolean;
  knockout_reasons: string[];
  processing_failed: boolean;
  processing_error: string | null;
  fit_score: number | null;
  score_reasons: string[];
  score_breakdown: ScoreBreakdown | null;
  manual_score_adjustment: number | null;
  manual_adjustment_reason: string | null;
  bucket: Bucket | null;
  override_bucket: Bucket | null;
  override_reason: string | null;
  uploaded_by_user_id: string | null;
  uploaded_by_email: string | null;
  source: string | null;
  archived: boolean;
  archived_reason: string | null;
}

export type SessionStatus =
  | "scheduled"
  | "identity_pending"
  | "in_progress"
  | "completed";

export interface InterviewSession {
  id: string;
  candidate_name: string;
  job_id: string | null;
  join_token: string;
  video_room_token: string;
  status: SessionStatus;
  integrity_score: number | null;
  integrity_needs_review: boolean;
  recording_file_path: string | null;
  transcript: string | null;
  transcript_status: "pending" | "done" | "failed" | null;
  interviewer_join_token: string | null;
  interviewer_recording_file_path: string | null;
  interviewer_transcript: string | null;
  interviewer_transcript_status: "pending" | "done" | "failed" | null;
  merged_transcript: string | null;
  qa_analysis: QaAnalysis | null;
  voice_tone_analysis: VoiceToneAnalysis | null;
  facial_affect_analysis: FacialAffectAnalysis | null;
  sentiment_trend: SentimentTrend | null;
  candidate_ip: string | null;
  interviewer_live_decision: "proceed" | "concern" | "reject" | null;
  interviewer_live_notes: string | null;
  ice_servers: IceServer[] | null;
  livekit_token: string | null;
  livekit_url: string | null;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SentimentTrend {
  sample_count: number;
  tension_distribution: Record<"low" | "medium" | "high", number>;
  dominant_tension: "low" | "medium" | "high" | "unknown";
  summary: string;
  error?: string;
}

export interface IdentityCheck {
  id: string;
  session_id: string;
  liveness_prompt: string | null;
  liveness_passed: boolean | null;
  match_confidence: number | null;
  match_verdict: "match" | "no_match" | "uncertain" | null;
  needs_human_review: boolean;
  cleared_by_hr: boolean;
  cleared_reason: string | null;
}

export interface QaExchange {
  question: string;
  answer: string;
  verdict: "relevant" | "partially_relevant" | "off_topic" | "evasive";
  explanation: string;
}

export interface QaAnalysis {
  no_questions_detected: boolean;
  exchanges: QaExchange[];
  error?: string;
}

export interface VoiceToneAnalysis {
  overall_tone: string;
  confidence_level: "low" | "medium" | "high";
  notes: string;
  error?: string;
}

export interface FacialAffectAnalysis {
  face_visible: boolean;
  overall_affect: string;
  tension_level: "low" | "medium" | "high";
  notes: string;
  error?: string;
}

export type SignalType =
  | "tab_switch"
  | "window_blur"
  | "copy_paste"
  | "second_face"
  | "second_voice"
  | "voice_mismatch"
  | "gaze_off_screen"
  | "excessive_motion"
  | "virtual_camera"
  | "response_timing_anomaly"
  | "unauthorized_app_detected"
  | "external_display_detected"
  | "fullscreen_exit"
  | "devtools_open"
  | "screen_share_partial"
  | "screen_share_stopped"
  | "location_mismatch"
  | "ai_extension_detected"
  | "teleprompter_reading";

export interface LiveSignalEvent {
  signal_type: SignalType;
  session_offset_ms: number;
  meta: Record<string, unknown>;
}

export interface IntegrityFlag {
  id: string;
  session_offset_ms: number;
  severity: number;
  summary: string;
  reviewed: boolean;
  reviewer_decision: string | null;
  reviewer_note: string | null;
}
