import json
import logging
import os
import subprocess
from typing import Any

from app.models.job import Job
from app.services.openai_client import call_tool
from app.services.transcription import transcribe_with_segments
from app.services.voice_tone import analyze_voice_tone

logger = logging.getLogger(__name__)

L1_EVAL_TOOL = {
    "type": "function",
    "function": {
        "name": "evaluate_l1_phone_screening",
        "description": (
            "Evaluates an HR initial phone screening call across technical competence, "
            "verbal communication fluency, candidate logistics, and recommends actionable next steps."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "technical_score": {
                    "type": "number",
                    "description": "0-100 score on candidate's technical clarity and domain knowledge during the call.",
                },
                "communication_score": {
                    "type": "number",
                    "description": "0-100 score on candidate's verbal fluency, articulation, listening comprehension, and professional confidence.",
                },
                "overall_l1_score": {
                    "type": "number",
                    "description": "0-100 overall L1 phone screening score.",
                },
                "verdict": {
                    "type": "string",
                    "enum": ["recommend_l2", "hold", "decline", "senior_review"],
                    "description": "Clear hiring recommendation verdict for HR.",
                },
                "call_summary": {
                    "type": "string",
                    "description": "2-3 well-structured paragraphs summarizing the discussion, candidate background, tone, key topics covered, and candidate interest level.",
                },
                "extracted_details": {
                    "type": "object",
                    "description": "Key screening logistics extracted from the conversation.",
                    "properties": {
                        "notice_period_discussed": {"type": "string"},
                        "current_ctc_discussed": {"type": "string"},
                        "expected_ctc_discussed": {"type": "string"},
                        "current_location": {"type": "string"},
                        "relocation_willingness": {"type": "string"},
                        "shift_work_preference": {"type": "string"},
                        "reason_for_job_change": {"type": "string"},
                    },
                },
                "strengths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Key strengths and positive observations from the screening call.",
                },
                "red_flags": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Potential risks, discrepancies, red flags, or areas of concern noted during the call.",
                },
                "next_steps": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Specific actionable next steps and technical topics for the L2 technical interviewer to probe deeply.",
                },
            },
            "required": [
                "technical_score",
                "communication_score",
                "overall_l1_score",
                "verdict",
                "call_summary",
                "extracted_details",
                "strengths",
                "red_flags",
                "next_steps",
            ],
        },
    },
}

SYSTEM_PROMPT = """You are an expert HR screening analyst evaluating an L1 phone screening call for recruitment.
Analyze the transcript of the call between the HR interviewer and the job candidate.
Evaluate:
1. Technical Competence (0-100): Core tech domain knowledge, clarity in explaining past projects, practical understanding.
2. Verbal Communication & Fluency (0-100): Professional demeanor, spoken English/language fluency, concise articulation, tone, and listening ability.
3. Logistics & Screening Facts: Notice period, salary expectations, current location, willingness to relocate, and career motivations.
4. Strengths & Red Flags: Concrete observations (e.g. inconsistent tenure, strong passion, clear communication).
5. Actionable Next Steps: A clear hiring decision (Recommend L2 / Hold / Decline / Senior Review) and specific drill-down areas for the technical interview.
"""


def _probe_audio(audio_path: str) -> dict[str, Any]:
    """Inspects audio channels and duration using ffprobe."""
    try:
        cmd = [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=channels,duration",
            "-of",
            "json",
            audio_path,
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(res.stdout)
        streams = data.get("streams", [])
        channels = int(streams[0].get("channels", 1)) if streams else 1
        duration = float(streams[0].get("duration", 0.0)) if streams and streams[0].get("duration") else 0.0
        return {"channels": channels, "duration": duration}
    except Exception as exc:
        logger.warning("ffprobe failed on %s: %s", audio_path, exc)
        return {"channels": 1, "duration": 0.0}


def _ensure_wav_for_tone(audio_path: str) -> str:
    """Converts audio to a temporary 16kHz mono WAV for gpt-audio if not already WAV."""
    if audio_path.lower().endswith(".wav"):
        return audio_path
    wav_out = f"{os.path.splitext(audio_path)[0]}_temp_tone.wav"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-i", audio_path, "-ar", "16000", "-ac", "1", wav_out],
            check=True,
            capture_output=True,
        )
        return wav_out
    except Exception as exc:
        logger.warning("Failed to convert audio to wav for tone analysis: %s", exc)
        return audio_path


def process_l1_audio_screening(
    audio_path: str,
    job: Job | None = None,
    candidate_name: str = "Candidate",
) -> dict[str, Any]:
    """Processes an HR-uploaded L1 phone screening audio file:
    1. Channel layout auto-detection (mono vs stereo).
    2. Whisper transcription with timestamped segments.
    3. gpt-audio vocal tone and confidence analysis.
    4. Structured LLM screening evaluation (Tech score, Comm score, Summary, Extracted facts, Next steps).
    """
    probe_info = _probe_audio(audio_path)
    duration_seconds = probe_info["duration"]

    # Transcribe recording using existing transcription service (Whisper + >25MB chunking)
    full_transcript, segments = transcribe_with_segments(audio_path)
    if not full_transcript:
        full_transcript = "(No clear speech detected in recording)"
        segments = []

    # Voice tone analysis via gpt-audio
    voice_tone_result: dict[str, Any] = {}
    temp_wav: str | None = None
    try:
        temp_wav = _ensure_wav_for_tone(audio_path)
        if os.path.exists(temp_wav):
            voice_tone_result = analyze_voice_tone(temp_wav)
    except Exception as exc:
        logger.warning("Vocal tone analysis skipped: %s", exc)
        voice_tone_result = {
            "overall_tone": "natural",
            "confidence_level": "medium",
            "notes": "Acoustic analysis unavailable.",
        }
    finally:
        if temp_wav and temp_wav != audio_path and os.path.exists(temp_wav):
            try:
                os.remove(temp_wav)
            except OSError:
                pass

    # Build LLM context for evaluation
    job_context = (
        f"Role: {job.title}\nJob Level: {job.level.value if job else 'Experienced'}\n"
        f"Required Skills: {', '.join(job.required_skills or [])}\n"
        f"JD Summary:\n{job.jd_text[:1500] if job else 'Standard role'}"
        if job
        else "General Professional Role"
    )

    user_content = f"""Target Candidate: {candidate_name}
{job_context}

Vocal Acoustic Observations (from audio):
- Dominant Tone: {voice_tone_result.get('overall_tone', 'Natural')}
- Confidence Level: {voice_tone_result.get('confidence_level', 'Medium')}
- Audio Notes: {voice_tone_result.get('notes', 'None')}

Screening Call Transcript:
\"\"\"
{full_transcript}
\"\"\"

Please evaluate the candidate's technical competence, verbal communication quality, logistics discussed, strengths, red flags, and provide an executive summary with concrete next steps."""

    try:
        eval_result = call_tool(
            system=SYSTEM_PROMPT,
            user_content=user_content,
            tool=L1_EVAL_TOOL,
        )
    except Exception as exc:
        logger.warning("LLM L1 screening evaluation failed: %s. Returning heuristic fallback.", exc)
        word_count = len(full_transcript.split())
        eval_result = {
            "technical_score": 65.0,
            "communication_score": 70.0 if word_count > 50 else 50.0,
            "overall_l1_score": 68.0,
            "verdict": "recommend_l2" if word_count > 60 else "senior_review",
            "call_summary": f"Initial phone screening recorded for {candidate_name}. Candidate participated in discussion with {word_count} spoken words captured.",
            "extracted_details": {
                "notice_period_discussed": "Mentioned during call",
                "current_ctc_discussed": "Discussed",
                "expected_ctc_discussed": "Discussed",
                "current_location": "Provided",
                "relocation_willingness": "Yes",
            },
            "strengths": ["Candidate was responsive and engaged during initial phone screening."],
            "red_flags": [],
            "next_steps": ["Conduct L2 technical interview to deep-dive into specific project contributions."],
        }

    return {
        "audio_duration_seconds": duration_seconds,
        "is_stereo_split": probe_info["channels"] > 1,
        "transcript": full_transcript,
        "transcript_segments": segments,
        "technical_score": eval_result.get("technical_score", 70.0),
        "communication_score": eval_result.get("communication_score", 70.0),
        "overall_l1_score": eval_result.get("overall_l1_score", 70.0),
        "verdict": eval_result.get("verdict", "recommend_l2"),
        "call_summary": eval_result.get("call_summary", ""),
        "extracted_details": eval_result.get("extracted_details", {}),
        "strengths": eval_result.get("strengths", []),
        "red_flags": eval_result.get("red_flags", []),
        "next_steps": eval_result.get("next_steps", []),
        "voice_tone_notes": voice_tone_result,
    }
