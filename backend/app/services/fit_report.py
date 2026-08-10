from fpdf import FPDF

from app.models.candidate import Candidate
from app.models.job import Job

CATEGORY_LABELS = {
    "skills": "Skills",
    "experience": "Experience",
    "education": "Education",
    "certifications": "Certifications",
}

# The built-in "Helvetica" PDF font only supports Latin-1 — LLM-generated reason text
# routinely includes characters outside that (✓/✗, em-dashes, smart quotes), which would
# otherwise crash rendering outright (FPDFUnicodeEncodingException). Map the common ones to
# readable ASCII, then fall back to dropping anything else unrenderable rather than crashing.
_CHAR_REPLACEMENTS = {
    "✓": "[Yes]", "✔": "[Yes]",  # ✓ ✔
    "✗": "[No]", "✘": "[No]",  # ✗ ✘
    "—": "-", "–": "-",  # — –
    "‘": "'", "’": "'",  # ‘ ’
    "“": '"', "”": '"',  # “ ”
    "…": "...",  # …
}


def _sanitize(text: str) -> str:
    for original, replacement in _CHAR_REPLACEMENTS.items():
        text = text.replace(original, replacement)
    # Latin-1 covers exactly code points 0-255 — anything past that (CJK, emoji, etc.)
    # would otherwise be silently swapped for a bare "?" by the encode() below with no
    # sign anything was dropped. Flag it visibly instead.
    if any(ord(ch) > 255 for ch in text):
        text = text.encode("latin-1", "replace").decode("latin-1")
        text += " [some characters could not be displayed]"
        return text
    return text


def _score_label(score: float) -> str:
    if score >= 85:
        return "Excellent fit"
    if score >= 70:
        return "Strong fit"
    if score >= 55:
        return "Good fit"
    if score >= 40:
        return "Fair fit"
    return "Weak fit"


def build_fit_report_pdf(candidate: Candidate, job: Job) -> bytes:
    """A downloadable summary of the AI fit assessment — deliberately not the resume
    itself (HR already has that from the upload); this is the score + reasoning HR would
    otherwise have to reconstruct by clicking through the candidate page."""
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, "Candidate Fit Report", new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "", 11)
    name = _sanitize(candidate.full_name or candidate.email or "Unnamed candidate")
    pdf.cell(0, 7, f"Candidate: {name}", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 7, f"Job: {_sanitize(job.title)}", new_x="LMARGIN", new_y="NEXT")
    if candidate.email:
        pdf.cell(0, 7, f"Email: {_sanitize(candidate.email)}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    pdf.set_font("Helvetica", "B", 13)
    if candidate.fit_score is not None:
        effective = candidate.fit_score + (candidate.manual_score_adjustment or 0)
        effective = max(0.0, min(100.0, effective))
        pdf.cell(
            0, 8, f"Overall fit: {_score_label(effective)} ({effective:.0f}/100)",
            new_x="LMARGIN", new_y="NEXT",
        )
        if candidate.manual_score_adjustment:
            pdf.set_font("Helvetica", "", 10)
            sign = "+" if candidate.manual_score_adjustment > 0 else ""
            adjustment_reason = _sanitize(candidate.manual_adjustment_reason or "")
            pdf.cell(
                0, 6,
                f"(AI score {candidate.fit_score:.0f}, HR adjustment {sign}"
                f"{candidate.manual_score_adjustment}: {adjustment_reason})",
                new_x="LMARGIN", new_y="NEXT",
            )
    else:
        pdf.cell(0, 8, "Overall fit: not scored", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    effective_bucket = candidate.override_bucket or candidate.bucket
    if effective_bucket:
        pdf.set_font("Helvetica", "", 11)
        pdf.cell(0, 7, f"Decision: {effective_bucket.value.capitalize()}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    if candidate.knockout_failed:
        pdf.set_font("Helvetica", "B", 12)
        pdf.cell(0, 8, "Not eligible", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 10)
        for reason in candidate.knockout_reasons or []:
            pdf.multi_cell(0, 6, f"- {_sanitize(reason)}", new_x="LMARGIN", new_y="NEXT")
        pdf.ln(2)

    if candidate.score_breakdown:
        pdf.set_font("Helvetica", "B", 12)
        pdf.cell(0, 8, "Score breakdown", new_x="LMARGIN", new_y="NEXT")
        for category, label in CATEGORY_LABELS.items():
            entry = candidate.score_breakdown.get(category)
            if not entry:
                continue
            pdf.set_font("Helvetica", "B", 11)
            pdf.cell(0, 7, f"{label}: {entry.get('score', 0):.0f}/100", new_x="LMARGIN", new_y="NEXT")
            pdf.set_font("Helvetica", "", 10)
            for reason in entry.get("reasons", []):
                pdf.multi_cell(0, 6, f"- {_sanitize(reason)}", new_x="LMARGIN", new_y="NEXT")
            pdf.ln(1)

    output = pdf.output()
    return bytes(output)
