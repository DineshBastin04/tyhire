"""Test harness for the backend suite.

Runs against a DEDICATED Postgres database (``tyhire_test`` by default), never the application
database — created on the same server if missing and its tables dropped/recreated per session.
This keeps tests on the real engine (the models use Postgres-specific column types) while
guaranteeing they can never read or write live data.

Designed to run inside the backend container, where the DB host and the required secrets are
already in the environment:

    pip install -r requirements-dev.txt && python -m pytest tests -q

The FastAPI startup events are deliberately NOT triggered (the TestClient is used without its
context manager), so the app's own ``create_all`` + bootstrap never touches the prod engine.
"""

import os
import uuid

# Secrets the Settings model requires at import — only set if absent, so the container's real
# values win when present. Never point tests at the live DB.
os.environ.setdefault("SESSION_SECRET", "test-session-secret")
os.environ.setdefault("TURN_SECRET", "test-turn-secret")
os.environ.setdefault("OPENAI_API_KEY", "test-key-not-used")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

import bcrypt  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.db.session import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.models.candidate import Bucket, Candidate  # noqa: E402
from app.models.job import Job  # noqa: E402
from app.models.user import User  # noqa: E402

TEST_DB_NAME = os.environ.get("TEST_DB_NAME", "tyhire_test")


def _test_database_url():
    # Return the URL object, not str(): re-stringifying can URL-re-encode a password that
    # contains special characters and break authentication. create_engine accepts a URL object.
    return make_url(settings.database_url).set(database=TEST_DB_NAME)


def _ensure_test_database() -> None:
    """Create the test database on the same server if it doesn't already exist."""
    admin_url = make_url(settings.database_url).set(database="postgres")
    admin_engine = create_engine(admin_url, isolation_level="AUTOCOMMIT")
    try:
        with admin_engine.connect() as conn:
            exists = conn.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :n"), {"n": TEST_DB_NAME}
            ).scalar()
            if not exists:
                conn.execute(text(f'CREATE DATABASE "{TEST_DB_NAME}"'))
    finally:
        admin_engine.dispose()


@pytest.fixture(scope="session")
def engine():
    _ensure_test_database()
    eng = create_engine(_test_database_url())
    Base.metadata.drop_all(bind=eng)
    Base.metadata.create_all(bind=eng)
    yield eng
    Base.metadata.drop_all(bind=eng)
    eng.dispose()


@pytest.fixture()
def db_session(engine):
    """A fresh session per test, with all table rows cleared first for isolation."""
    TestingSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    # Clean slate every test — order-independent since we TRUNCATE all tables.
    with engine.begin() as conn:
        tables = ", ".join(f'"{t.name}"' for t in reversed(Base.metadata.sorted_tables))
        conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    session = TestingSessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def client(db_session):
    """Unauthenticated client wired to the test DB."""
    def _override_get_db():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    # No `with` — don't trigger startup events (they'd hit the prod engine).
    test_client = TestClient(app)
    yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def hr_user(db_session):
    user = User(
        email="recruiter@tyhire.test",
        password_hash=bcrypt.hashpw(b"pw-secret-123", bcrypt.gensalt()).decode(),
        display_name="Test Recruiter",
        is_admin=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture()
def auth_client(client, hr_user):
    """Logged-in client — carries the hr_session cookie on every subsequent request."""
    res = client.post("/api/v1/auth/login", json={"email": hr_user.email, "password": "pw-secret-123"})
    assert res.status_code == 200, res.text
    return client


# ---- data factories ----------------------------------------------------------------------
def make_job(db_session, title="Senior Backend Engineer") -> Job:
    job = Job(
        title=title,
        jd_text="Build and scale FastAPI services. 3+ years Python, Postgres, Docker.",
        required_skills=["Python", "FastAPI", "PostgreSQL"],
    )
    db_session.add(job)
    db_session.commit()
    db_session.refresh(job)
    return job


def make_candidate(
    db_session,
    job,
    name="Alex Doe",
    fit_score=82.0,
    bucket=Bucket.approved,
    **kwargs,
) -> Candidate:
    cand = Candidate(
        job_id=job.id,
        resume_file_path=f"resumes/{job.id}/{uuid.uuid4()}.pdf",
        full_name=name,
        email=f"{uuid.uuid4().hex[:8]}@ex.test",
        fit_score=fit_score,
        technical_score=kwargs.pop("technical_score", 80.0),
        communication_score=kwargs.pop("communication_score", 75.0),
        bucket=bucket,
        parsed_profile=kwargs.pop(
            "parsed_profile",
            {
                "skills": ["Python", "FastAPI", "Docker"],
                "experience": ["3 yrs Backend Engineer at Acme"],
                "education": ["B.Tech CS"],
                "total_years_experience": 3,
            },
        ),
        skills_breakdown=kwargs.pop(
            "skills_breakdown",
            {
                "relevant_skills": ["Python", "FastAPI"],
                "missing_critical_skills": ["PostgreSQL"],
                "irrelevant_skills": [],
            },
        ),
        score_breakdown=kwargs.pop("score_breakdown", {"skills": {"score": 80, "reasons": ["Strong Python"]}}),
        **kwargs,
    )
    db_session.add(cand)
    db_session.commit()
    db_session.refresh(cand)
    return cand
