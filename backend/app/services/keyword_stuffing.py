import fitz  # PyMuPDF


def detect_keyword_stuffing(pdf_content: bytes) -> dict:
    """Parses a PDF using PyMuPDF to identify text spans that are:
    1. Invisible (near-white or white color values matching background).
    2. Microscopic (font size less than 2.0pt) to bypass resume filters.

    Returns a dict containing:
      - 'detected' (bool): True if keyword stuffing was detected.
      - 'reason' (str | None): Description of the stuffed elements and pages.
      - 'stuffed_text' (str): Sample of the hidden/tiny text extracted.
    """
    try:
        doc = fitz.open(stream=pdf_content, filetype="pdf")
    except Exception as exc:
        return {
            "detected": False,
            "reason": f"Failed to open PDF for validation: {exc}",
            "stuffed_text": "",
        }

    stuffed_spans = []

    try:
        for page_idx, page in enumerate(doc):
            text_dict = page.get_text("dict")
            for block in text_dict.get("blocks", []):
                if block.get("type") != 0:  # Skip non-text blocks (like images)
                    continue
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        text = (span.get("text") or "").strip()
                        if not text:
                            continue

                        size = span.get("size", 12.0)
                        color_val = span.get("color", 0)

                        # Extract RGB color channels from decimal color value
                        r = (color_val >> 16) & 255
                        g = (color_val >> 8) & 255
                        b = color_val & 255

                        is_white = r >= 250 and g >= 250 and b >= 250
                        is_tiny = size < 2.0

                        if is_white or is_tiny:
                            stuffed_spans.append({
                                "text": text,
                                "page": page_idx + 1,
                                "reason": "white_text" if is_white else "tiny_text",
                                "size": size,
                                "color": f"#{r:02x}{g:02x}{b:02x}",
                            })
    finally:
        doc.close()

    if stuffed_spans:
        stuffed_text_str = " | ".join(s["text"] for s in stuffed_spans[:10])
        if len(stuffed_spans) > 10:
            stuffed_text_str += f" ... (and {len(stuffed_spans) - 10} more)"

        reasons = list({s["reason"] for s in stuffed_spans})
        reason_str = " & ".join(reasons).replace("white_text", "invisible white text").replace("tiny_text", "microscopic font text")

        return {
            "detected": True,
            "reason": f"Detected {reason_str} on page(s) {sorted(list({s['page'] for s in stuffed_spans}))}.",
            "stuffed_text": stuffed_text_str,
        }

    return {"detected": False, "reason": None, "stuffed_text": ""}
