from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql://hr_tool:hr_tool@localhost:5432/hr_tool"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o"
    storage_root: str = "../storage"
    cors_origins: list[str] = ["http://localhost:3000"]

    # Signs the HR session cookie — rotating this logs everyone out. Change for anything
    # beyond local testing; the fallback exists so the app doesn't hard-crash if unset, not
    # because it's safe.
    session_secret: str = "dev-secret-change-me"

    # Per-user HR accounts live in the `users` table now, created via POST /auth/users once
    # someone is logged in — but that requires a first account to already exist. If the
    # `users` table is empty at startup and both of these are set, one admin user is
    # auto-created so there's a way in; unset (or leave empty) once real accounts exist.
    initial_admin_email: str | None = None
    initial_admin_password: str | None = None

    # Path to a local MaxMind GeoLite2-City.mmdb file for the IP-based location signal
    # (services/geolocation.py). The signal is skipped entirely if unset or the file is
    # missing — download requires a free MaxMind account + license key.
    geoip_db_path: str | None = None

    # Fernet key (Fernet.generate_key()) for encrypting stored ID photos/selfies/recordings
    # at rest (services/storage.py). Opt-in — storage behaves exactly as before if unset.
    # Losing this key makes every already-encrypted file permanently unreadable, so back it
    # up like any other credential; it is NOT the same thing as SESSION_SECRET.
    storage_encryption_key: str | None = None

    # How long raw ID/selfie images are kept before the retention sweep deletes the image
    # files (keeping only the verdict/confidence, not the images) — similar in spirit to the
    # retention limits biometric-privacy statutes typically require.
    identity_media_retention_days: int = 90

    # The app enforces identity_media_retention_days itself via an in-process daily sweep so
    # retention doesn't silently depend on someone remembering to hit the manual endpoint.
    # Disable it (and drive `python -m app.jobs.run_retention_sweep` from external cron
    # instead) if you run multiple backend workers/replicas, so only one process sweeps.
    retention_sweep_enabled: bool = True
    retention_sweep_interval_hours: int = 24

    # Our own coturn TURN server (docker-compose.yml's coturn service) — a fallback relay
    # for the browser-to-browser call when a direct connection can't be made (strict
    # corporate firewalls, some mobile carriers). turn_secret must match coturn's own
    # TURN_SECRET; used to mint short-lived per-call credentials (services/video_provider.py)
    # rather than one fixed shared password.
    turn_domain: str = "localhost"
    turn_secret: str = "dev-turn-secret-change-me"

    # Google/Microsoft sign-in for HR (Phase 4) — only usable by emails that already match
    # an existing active user; blank until you create these in each provider's console.
    google_client_id: str | None = None
    google_client_secret: str | None = None
    microsoft_client_id: str | None = None
    microsoft_client_secret: str | None = None
    oauth_redirect_base_url: str = "http://localhost:8000/api/v1"
    frontend_base_url: str = "http://localhost:3000"

    class Config:
        env_file = ".env"


settings = Settings()
