"""App-wide logging setup — the backend previously had no logging framework at all.

Failures throughout the codebase were only ever recorded into whatever DB text field
happened to be nearby (e.g. session.transcript = f"Transcription failed: {exc}"). That
covers the one field it's attached to, but leaves every other failure — a background
task dying before it even reaches its own try/except, a step that has no dedicated
"_failed" field to write into — completely invisible outside of whatever happened to be
in a developer's terminal at the moment it occurred. Call setup_logging() once, at app
startup (see main.py), then use logging.getLogger(__name__) per module as usual.
"""
import logging

from app.core.config import settings


def setup_logging() -> None:
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
