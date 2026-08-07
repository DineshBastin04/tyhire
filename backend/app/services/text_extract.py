import base64
import io

from docx import Document
from pypdf import PdfReader

from app.services.openai_client import call_tool

# Below this length, native PDF text extraction is treated as having failed (a
# scanned/image-only PDF) rather than as "a genuinely short resume."
MIN_TEXT_LENGTH = 40

OCR_TOOL = {
    "type": "function",
    "function": {
        "name": "record_ocr_text",
        "description": "Records the text transcribed from a scanned resume page image.",
        "parameters": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "The literal text visible on the page, transcribed as-is.",
                },
            },
            "required": ["text"],
        },
    },
}

OCR_SYSTEM_PROMPT = (
    "You transcribe the literal text visible on a scanned resume page image. Transcribe "
    "exactly what's written — do not summarize, reformat, or add anything not on the page."
)


def extract_text(filename: str, content: bytes) -> tuple[str, bool]:
    """Returns (text, ocr_fallback_used).

    Native extraction is tried first; if it comes back (near-)empty — a scanned/image-based
    PDF, which pypdf can't read — falls back to OCR via vision on rendered page images,
    reusing the same image-to-OpenAI path already proven in identity_check.py rather than
    adding a separate OCR dependency like Tesseract.
    """
    lower = filename.lower()

    if lower.endswith(".pdf"):
        text = _extract_pdf_text(content)
        if len(text.strip()) >= MIN_TEXT_LENGTH:
            return text, False
        return _ocr_pdf(content), True

    if lower.endswith(".docx"):
        document = Document(io.BytesIO(content))
        return "\n".join(p.text for p in document.paragraphs), False

    return content.decode("utf-8", errors="ignore"), False


def _extract_pdf_text(content: bytes) -> str:
    reader = PdfReader(io.BytesIO(content))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def _ocr_pdf(content: bytes) -> str:
    import fitz  # PyMuPDF — pure-Python wheel, no system OCR binary required

    document = fitz.open(stream=content, filetype="pdf")
    try:
        return "\n".join(_ocr_image(page.get_pixmap(dpi=200).tobytes("png")) for page in document)
    finally:
        document.close()


def _ocr_image(image_bytes: bytes) -> str:
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    user_content = [
        {"type": "text", "text": "Resume page image:"},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
    ]
    result = call_tool(system=OCR_SYSTEM_PROMPT, user_content=user_content, tool=OCR_TOOL)
    return result["text"]
