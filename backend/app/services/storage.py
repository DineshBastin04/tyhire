"""Local-disk storage backend for the POC.

Kept behind this narrow interface (save_file / read_file / path_for) so a future
switch to S3-compatible storage only requires changing this module.

Encryption at rest (opt-in via STORAGE_ENCRYPTION_KEY): one-shot uploads (resumes, ID
photos, selfies, sentiment-sample clips) are encrypted the moment they're written, since
they're written once and never appended to. The continuously-growing interview recording
(built via append_file_chunk across many chunk uploads during a live call) is a different
case — Fernet tokens can't be concatenated and decrypted as one, so that file is written
in plaintext while it's still growing and only encrypted once, in place, after the
recording is finished (see finalize_encrypt, called from POST /complete). Any consumer that
needs a real filesystem path to hand to ffmpeg/whisper (which can't read a Fernet token
directly) goes through decrypted_temp_copy, which transparently no-ops when no key is
configured — this whole module behaves exactly as before if STORAGE_ENCRYPTION_KEY is unset.
"""
import contextlib
import os
import shutil
import tempfile
import uuid

from app.core.config import settings

ENCRYPTED_SUFFIX = ".enc"


def _fernet():
    if not settings.storage_encryption_key:
        return None
    from cryptography.fernet import Fernet

    return Fernet(settings.storage_encryption_key.encode())


def _ensure_dir(sub_dir: str) -> str:
    full_dir = os.path.join(settings.storage_root, sub_dir)
    os.makedirs(full_dir, exist_ok=True)
    return full_dir


def save_file(sub_dir: str, filename: str, content: bytes) -> str:
    """Saves content under storage_root/sub_dir/<uuid>_<filename> (encrypted, plus a
    trailing .enc, if a key is configured) and returns the relative path."""
    directory = _ensure_dir(sub_dir)
    safe_name = f"{uuid.uuid4().hex}_{filename}"

    fernet = _fernet()
    if fernet:
        content = fernet.encrypt(content)
        safe_name += ENCRYPTED_SUFFIX

    full_path = os.path.join(directory, safe_name)
    with open(full_path, "wb") as f:
        f.write(content)
    return os.path.join(sub_dir, safe_name)


def append_file_chunk(sub_dir: str, filename: str, chunk: bytes) -> str:
    """Appends a chunk to (creating if needed) storage_root/sub_dir/filename. Always
    plaintext while growing — see module docstring; call finalize_encrypt once the file
    is done growing if it needs to be encrypted at rest."""
    directory = _ensure_dir(sub_dir)
    full_path = os.path.join(directory, filename)
    with open(full_path, "ab") as f:
        f.write(chunk)
    return os.path.join(sub_dir, filename)


def finalize_encrypt(relative_path: str | None) -> str | None:
    """Encrypts a finished (no-longer-growing) file in place and returns its new relative
    path (with a .enc suffix). No-ops and returns the input unchanged if no key is
    configured or the path is already encrypted."""
    if not relative_path or relative_path.endswith(ENCRYPTED_SUFFIX):
        return relative_path
    fernet = _fernet()
    if not fernet:
        return relative_path

    full_path = absolute_path(relative_path)
    with open(full_path, "rb") as f:
        plaintext = f.read()
    encrypted_path = full_path + ENCRYPTED_SUFFIX
    with open(encrypted_path, "wb") as f:
        f.write(fernet.encrypt(plaintext))
    os.remove(full_path)
    return relative_path + ENCRYPTED_SUFFIX


def read_file(relative_path: str) -> bytes:
    full_path = os.path.join(settings.storage_root, relative_path)
    with open(full_path, "rb") as f:
        content = f.read()
    if relative_path.endswith(ENCRYPTED_SUFFIX):
        fernet = _fernet()
        if not fernet:
            raise RuntimeError(
                f"{relative_path} is encrypted but STORAGE_ENCRYPTION_KEY is not configured"
            )
        content = fernet.decrypt(content)
    return content


def absolute_path(relative_path: str) -> str:
    return os.path.join(settings.storage_root, relative_path)


def remove_directory(sub_dir: str) -> None:
    """Recursively removes storage_root/sub_dir and everything under it — e.g. an entire
    interview session's recording/identity-photos/sentiment-clips live under one
    interviews/{session_id}/ prefix, so this is simpler and more complete than tracking
    every individual file path. Silently no-ops if the directory doesn't exist."""
    shutil.rmtree(absolute_path(sub_dir), ignore_errors=True)


@contextlib.contextmanager
def decrypted_temp_copy(relative_path: str):
    """Yields a real filesystem path to plaintext content — the original file directly if
    it isn't encrypted, or a temp-file copy (cleaned up on exit) if it is. Use this instead
    of absolute_path() wherever the caller needs to hand a path to ffmpeg/whisper/anything
    that reads the file directly rather than through this module."""
    if not relative_path.endswith(ENCRYPTED_SUFFIX):
        yield absolute_path(relative_path)
        return

    content = read_file(relative_path)
    suffix = os.path.splitext(relative_path[: -len(ENCRYPTED_SUFFIX)])[1]
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(content)
        tmp.close()
        yield tmp.name
    finally:
        with contextlib.suppress(OSError):
            os.remove(tmp.name)
