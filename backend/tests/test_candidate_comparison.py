"""Tests for POST /api/v1/jobs/{job_id}/candidates/compare.

The OpenAI integration is always mocked — no test makes a real API call or incurs cost.
"""

import uuid

import pytest

from app.core.config import settings
from app.models.candidate import Bucket, Candidate
from app.models.interview import InterviewSession, SessionStatus
from app.models.l1_screening import L1PhoneScreening
from app.services import candidate_comparison as cmp
from app.services.openai_client import OpenAIToolError
from tests.conftest import make_candidate, make_job

COMPARE_PATH = "/api/v1/jobs/{job_id}/candidates/compare"


def _valid_ai_result(refs):
    """A well-formed tool payload covering exactly the given refs."""
    return {
        "overall_summary": "Both candidates are credible for the role.",
        "per_candidate": [
            {
                "ref": ref,
                "strengths": [f"{ref} knows Python"],
                "gaps": [f"{ref} lacks PostgreSQL depth"],
                "evidence": [f"{ref} listed FastAPI"],
                "insufficient_data": [],
            }
            for ref in refs
        ],
        "differentiators": [{"criterion": "Experience", "detail": "c1 has more tenure."}],
        "follow_up_questions": ["Ask about production Postgres tuning."],
        "conclusion": "Advisory: c1 edges ahead on experience; recruiter decides.",
    }


@pytest.fixture()
def patch_ai_ok(monkeypatch):
    """Patch the AI call to echo a valid result for whatever refs were sent."""
    def fake_call_tool(system, user_content, tool, timeout=None):
        # Derive the refs from the structured user content (c1, c2, ...).
        import re

        refs = sorted(set(re.findall(r'"ref": "(c\d+)"', user_content)))
        return _valid_ai_result(refs)

    monkeypatch.setattr(cmp, "call_tool", fake_call_tool)
    return fake_call_tool


# ---- happy paths --------------------------------------------------------------------------
def test_compare_two_candidates(auth_client, db_session, patch_ai_ok):
    job = make_job(db_session)
    c1 = make_candidate(db_session, job, name="Alex")
    c2 = make_candidate(db_session, job, name="Blair")

    res = auth_client.post(
        COMPARE_PATH.format(job_id=job.id),
        json={"candidate_ids": [str(c1.id), str(c2.id)]},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ai_available"] is True
    assert body["candidate_count"] == 2
    assert len(body["table"]) == 2
    assert len(body["analysis"]["per_candidate"]) == 2
    # Every analysis entry maps to a real requested candidate id.
    returned_ids = {a["candidate_id"] for a in body["analysis"]["per_candidate"]}
    assert returned_ids == {str(c1.id), str(c2.id)}


def test_compare_several_candidates(auth_client, db_session, patch_ai_ok):
    job = make_job(db_session)
    cands = [make_candidate(db_session, job, name=f"Cand{i}") for i in range(5)]

    res = auth_client.post(
        COMPARE_PATH.format(job_id=job.id),
        json={"candidate_ids": [str(c.id) for c in cands]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["candidate_count"] == 5
    assert len(res.json()["table"]) == 5


def test_compare_at_max(auth_client, db_session, patch_ai_ok, monkeypatch):
    monkeypatch.setattr(settings, "comparison_max_candidates", 3)
    job = make_job(db_session)
    cands = [make_candidate(db_session, job, name=f"Cand{i}") for i in range(3)]
    res = auth_client.post(
        COMPARE_PATH.format(job_id=job.id),
        json={"candidate_ids": [str(c.id) for c in cands]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["max_candidates"] == 3


def test_compare_includes_l1_and_interview(auth_client, db_session, patch_ai_ok):
    job = make_job(db_session)
    c1 = make_candidate(db_session, job, name="Alex")
    c2 = make_candidate(db_session, job, name="Blair")
    db_session.add(
        L1PhoneScreening(
            candidate_id=c1.id,
            job_id=job.id,
            overall_l1_score=72.0,
            verdict="recommend_l1",
            strengths=["clear communicator"],
            red_flags=[],
            call_summary="Solid screening call.",
        )
    )
    db_session.add(
        InterviewSession(
            candidate_id=c1.id,
            candidate_name="Alex",
            job_id=job.id,
            join_token=uuid.uuid4().hex,
            video_room_token=uuid.uuid4().hex,
            status=SessionStatus.completed,
            interviewer_live_decision="proceed",
            integrity_needs_review=False,
            qa_analysis={"exchanges": [{"verdict": "relevant"}, {"verdict": "off_topic"}]},
        )
    )
    db_session.commit()

    res = auth_client.post(
        COMPARE_PATH.format(job_id=job.id),
        json={"candidate_ids": [str(c1.id), str(c2.id)]},
    )
    assert res.status_code == 200, res.text
    rows = {r["candidate_id"]: r for r in res.json()["table"]}
    row1 = rows[str(c1.id)]
    assert row1["l1"]["verdict"] == "recommend_l1"
    assert row1["interview"]["status"] == "completed"
    assert row1["interview"]["qa_relevant_count"] == 1
    assert row1["interview"]["qa_total_count"] == 2
    # c2 has neither — honestly reported as missing, not fabricated.
    row2 = rows[str(c2.id)]
    assert row2["l1"] is None
    assert row2["interview"] is None
    assert "L1 phone screening" in row2["data_completeness"]


# ---- validation / rejection ---------------------------------------------------------------
def test_reject_fewer_than_two(auth_client, db_session, patch_ai_ok):
    job = make_job(db_session)
    c1 = make_candidate(db_session, job)
    res = auth_client.post(
        COMPARE_PATH.format(job_id=job.id), json={"candidate_ids": [str(c1.id)]}
    )
    assert res.status_code == 422  # schema min_length=2


def test_reject_duplicate_ids(auth_client, db_session, patch_ai_ok):
    job = make_job(db_session)
    c1 = make_candidate(db_session, job)
    res = auth_client.post(
        COMPARE_PATH.format(job_id=job.id),
        json={"candidate_ids": [str(c1.id), str(c1.id)]},
    )
    assert res.status_code == 400
    assert "distinct" in res.json()["detail"].lower()


def test_reject_above_max(auth_client, db_session, patch_ai_ok, monkeypatch):
    monkeypatch.setattr(settings, "comparison_max_candidates", 2)
    job = make_job(db_session)
    cands = [make_candidate(db_session, job, name=f"C{i}") for i in range(3)]
    res = auth_client.post(
        COMPARE_PATH.format(job_id=job.id),
        json={"candidate_ids": [str(c.id) for c in cands]},
    )
    assert res.status_code == 400
    assert "at most 2" in res.json()["detail"]


def test_reject_candidate_from_other_job(auth_client, db_session, patch_ai_ok):
    job_a = make_job(db_session, title="Job A")
    job_b = make_job(db_session, title="Job B")
    c_a = make_candidate(db_session, job_a, name="InA")
    c_b = make_candidate(db_session, job_b, name="InB")
    res = auth_client.post(
        COMPARE_PATH.format(job_id=job_a.id),
        json={"candidate_ids": [str(c_a.id), str(c_b.id)]},
    )
    assert res.status_code == 400
    assert "do not belong" in res.json()["detail"]


def test_reject_unknown_candidate_id(auth_client, db_session, patch_ai_ok):
    job = make_job(db_session)
    c1 = make_candidate(db_session, job)
    res = auth_client.post(
        COMPARE_PATH.format(job_id=job.id),
        json={"candidate_ids": [str(c1.id), str(uuid.uuid4())]},
    )
    assert res.status_code == 400


def test_reject_unknown_job(auth_client, db_session, patch_ai_ok):
    res = auth_client.post(
        COMPARE_PATH.format(job_id=uuid.uuid4()),
        json={"candidate_ids": [str(uuid.uuid4()), str(uuid.uuid4())]},
    )
    assert res.status_code == 404


def test_requires_authentication(client, db_session, patch_ai_ok):
    job = make_job(db_session)
    c1 = make_candidate(db_session, job)
    c2 = make_candidate(db_session, job, name="Blair")
    res = client.post(  # note: unauthenticated client
        COMPARE_PATH.format(job_id=job.id),
        json={"candidate_ids": [str(c1.id), str(c2.id)]},
    )
    assert res.status_code == 401


# ---- AI failure / malformed handling ------------------------------------------------------
def test_ai_timeout_degrades_gracefully(auth_client, db_session, monkeypatch):
    def boom(system, user_content, tool, timeout=None):
        raise OpenAIToolError("request timed out")

    monkeypatch.setattr(cmp, "call_tool", boom)
    job = make_job(db_session)
    c1 = make_candidate(db_session, job)
    c2 = make_candidate(db_session, job, name="Blair")
    res = auth_client.post(
        COMPARE_PATH.format(job_id=job.id),
        json={"candidate_ids": [str(c1.id), str(c2.id)]},
    )
    # Graceful: the factual table is still returned; AI marked unavailable with a safe message.
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ai_available"] is False
    assert body["ai_error"]
    assert "timed out" not in body["ai_error"].lower()  # no internal detail leaked
    assert len(body["table"]) == 2


def test_malformed_ai_response_degrades(auth_client, db_session, monkeypatch):
    def malformed(system, user_content, tool, timeout=None):
        return {"unexpected": "shape"}  # missing required keys

    monkeypatch.setattr(cmp, "call_tool", malformed)
    job = make_job(db_session)
    c1 = make_candidate(db_session, job)
    c2 = make_candidate(db_session, job, name="Blair")
    res = auth_client.post(
        COMPARE_PATH.format(job_id=job.id),
        json={"candidate_ids": [str(c1.id), str(c2.id)]},
    )
    assert res.status_code == 200, res.text
    assert res.json()["ai_available"] is False


def test_ai_unrequested_ref_is_dropped(auth_client, db_session, monkeypatch):
    def with_extra_ref(system, user_content, tool, timeout=None):
        return {
            "overall_summary": "ok",
            "per_candidate": [
                {"ref": "c1", "strengths": ["a"], "gaps": [], "evidence": [], "insufficient_data": []},
                # c99 was never sent — must be ignored, not surfaced.
                {"ref": "c99", "strengths": ["ghost"], "gaps": [], "evidence": [], "insufficient_data": []},
                # c2 omitted on purpose — must be backfilled.
            ],
            "differentiators": [],
            "follow_up_questions": [],
            "conclusion": "done",
        }

    monkeypatch.setattr(cmp, "call_tool", with_extra_ref)
    job = make_job(db_session)
    c1 = make_candidate(db_session, job, name="Alex")
    c2 = make_candidate(db_session, job, name="Blair")
    res = auth_client.post(
        COMPARE_PATH.format(job_id=job.id),
        json={"candidate_ids": [str(c1.id), str(c2.id)]},
    )
    assert res.status_code == 200, res.text
    analyses = res.json()["analysis"]["per_candidate"]
    returned_ids = {a["candidate_id"] for a in analyses}
    # Exactly the two requested candidates — no ghost, and the omitted one is backfilled.
    assert returned_ids == {str(c1.id), str(c2.id)}
    assert all(a["ref"] in ("c1", "c2") for a in analyses)
    backfilled = next(a for a in analyses if a["candidate_id"] == str(c2.id))
    assert backfilled["insufficient_data"]  # noted as not analysed


# ---- integrity: comparison must never mutate state ----------------------------------------
def test_comparison_does_not_change_scores_or_buckets(auth_client, db_session, patch_ai_ok):
    job = make_job(db_session)
    c1 = make_candidate(db_session, job, name="Alex", fit_score=82.0, bucket=Bucket.approved)
    c2 = make_candidate(db_session, job, name="Blair", fit_score=60.0, bucket=Bucket.review)
    before = {
        c.id: (c.fit_score, c.bucket, c.override_bucket, c.technical_score)
        for c in (c1, c2)
    }

    res = auth_client.post(
        COMPARE_PATH.format(job_id=job.id),
        json={"candidate_ids": [str(c1.id), str(c2.id)]},
    )
    assert res.status_code == 200, res.text

    db_session.expire_all()
    for cid, (fit, bucket, override, tech) in before.items():
        row = db_session.get(Candidate, cid)
        assert row.fit_score == fit
        assert row.bucket == bucket
        assert row.override_bucket == override
        assert row.technical_score == tech
