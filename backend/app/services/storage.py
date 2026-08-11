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

Encryption only ever applies to files written *after* the key is set. Files written while it
was unset stay plaintext on disk, and read_file serves them as-is (it only decrypts .enc
paths). To encrypt that pre-existing backlog after enabling the key, run the one-shot backfill
once: `python -m app.jobs.encrypt_storage_backfill` (see services/storage_backfill.py).
"""
import contextlib
import os
import shutil
import subprocess
import tempfile
import uuid

from app.core.config import settings

ENCRYPTED_SUFFIX = ".enc"

# The fixed 4-byte magic number every WebM/Matroska stream opens with (the EBML header).
# A MediaRecorder's very first ondataavailable chunk carries it; every later chunk from
# that *same* recorder instance is pure cluster continuation data and never repeats it —
# see append_recording_chunk below.
EBML_MAGIC = b"\x1a\x45\xdf\xa3"


def _fernet():
    if not settings.storage_encryption_key:
        return None
    from cryptography.fernet import Fernet

    return Fernet(settings.storage_encryption_key.encode())


def _ensure_dir(sub_dir: str) -> str:
    full_dir = os.path.join(settings.storage_root, sub_dir)
    os.makedirs(full_dir, exist_ok=True)
    return full_dir


def _sanitize_filename(filename: str) -> str:
    """Strips directory components and traversal/ADS tricks from a client-supplied
    filename, keeping only a safe basename. Callers only need the extension/display
    name out of this value — the actual on-disk uniqueness comes from the uuid prefix
    added by save_file."""
    # Drop any directory portion regardless of which separator style the client used
    # (ntpath.basename / posixpath.basename only understand their own platform's).
    name = filename.replace("\\", "/").split("/")[-1]
    name = name.split(":")[0]  # strip NTFS alternate-data-stream suffixes
    name = name.strip().strip(".")
    return name or "file"


def _within_directory(directory: str, full_path: str) -> bool:
    real_dir = os.path.realpath(directory)
    real_path = os.path.realpath(full_path)
    return os.path.commonpath([real_dir, real_path]) == real_dir


def save_file(sub_dir: str, filename: str, content: bytes) -> str:
    """Saves content under storage_root/sub_dir/<uuid>_<filename> (encrypted, plus a
    trailing .enc, if a key is configured) and returns the relative path."""
    directory = _ensure_dir(sub_dir)
    safe_name = f"{uuid.uuid4().hex}_{_sanitize_filename(filename)}"

    fernet = _fernet()
    if fernet:
        content = fernet.encrypt(content)
        safe_name += ENCRYPTED_SUFFIX

    full_path = os.path.join(directory, safe_name)
    if not _within_directory(directory, full_path):
        raise ValueError(f"invalid filename: {filename!r}")
    with open(full_path, "wb") as f:
        f.write(content)
    return os.path.join(sub_dir, safe_name)


def append_file_chunk(sub_dir: str, filename: str, chunk: bytes) -> str:
    """Appends a chunk to (creating if needed) storage_root/sub_dir/filename. Always
    plaintext while growing — see module docstring; call finalize_encrypt once the file
    is done growing if it needs to be encrypted at rest."""
    directory = _ensure_dir(sub_dir)
    safe_name = _sanitize_filename(filename)
    full_path = os.path.join(directory, safe_name)
    if not _within_directory(directory, full_path):
        raise ValueError(f"invalid filename: {filename!r}")
    with open(full_path, "ab") as f:
        f.write(chunk)
    return os.path.join(sub_dir, safe_name)


def append_recording_chunk(
    sub_dir: str, current_relative_path: str | None, chunk: bytes
) -> tuple[str, bool]:
    """Appends a live-call recording chunk, detecting when `chunk` is actually the start
    of a brand new, independent MediaRecorder stream — e.g. the candidate's browser
    reconnected mid-interview and started recording again — rather than a continuation of
    the file at current_relative_path. Seeing the EBML magic number again on a file that
    already has bytes in it is that signal: a genuine continuation chunk from the *same*
    recorder never carries it. Blindly appending such a chunk (the old behavior) embeds a
    second, independent WebM container inside one file, which no single-file consumer can
    read past the first.

    Never overwrites or deletes an existing file — on detecting a new stream, it starts a
    new one instead and reports that back via the second return value so the caller can
    track the old path as a completed segment (see concat_segments, called at /complete).
    Returns (new_relative_path, is_new_segment).
    """
    directory = _ensure_dir(sub_dir)
    is_new_segment = False

    if current_relative_path:
        current_full_path = os.path.join(settings.storage_root, current_relative_path)
        has_content = os.path.exists(current_full_path) and os.path.getsize(current_full_path) > 0
        if has_content and chunk[:4] == EBML_MAGIC:
            is_new_segment = True

    if current_relative_path and not is_new_segment:
        relative_path = current_relative_path
        full_path = os.path.join(settings.storage_root, relative_path)
    else:
        filename = f"{uuid.uuid4().hex}_recording.webm"
        relative_path = os.path.join(sub_dir, filename)
        full_path = os.path.join(directory, filename)

    with open(full_path, "ab") as f:
        f.write(chunk)
    return relative_path, is_new_segment


def concat_segments(segment_relative_paths: list[str], sub_dir: str) -> str:
    """Stitches multiple independently-recorded WebM segments (see append_recording_chunk)
    back into one valid file, via ffmpeg's concat demuxer with a stream copy — no
    re-encode, since every segment came from the same browser/codec. Called once, at
    /complete, before finalize_encrypt, so encryption still applies exactly once to
    exactly one final file. Segment inputs are left in place on disk (cleaned up later by
    remove_directory when the whole session is deleted), not deleted here."""
    if len(segment_relative_paths) == 1:
        return segment_relative_paths[0]

    directory = _ensure_dir(sub_dir)
    list_path = os.path.join(directory, f"{uuid.uuid4().hex}_concat.txt")
    with open(list_path, "w", encoding="utf-8") as f:
        for rel_path in segment_relative_paths:
            # The concat demuxer resolves relative paths in this list file relative to the
            # list file's OWN directory, not the process's cwd — absolute_path()'s result
            # is itself cwd-relative (storage_root is "../storage"), so writing that as-is
            # here gets it resolved a second time and doubled. Fully resolving with
            # os.path.abspath first avoids that. Single quotes are escaped since the
            # demuxer parses this like a shell-ish mini-format.
            escaped = os.path.abspath(absolute_path(rel_path)).replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")

    output_filename = f"{uuid.uuid4().hex}_recording_merged.webm"
    output_path = os.path.join(directory, output_filename)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_path, "-c", "copy", output_path],
            check=True,
            capture_output=True,
        )
    finally:
        os.remove(list_path)

    return os.path.join(sub_dir, output_filename)


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
