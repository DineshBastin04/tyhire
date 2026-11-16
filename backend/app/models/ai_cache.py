from sqlalchemy import Column, DateTime, JSON, String, func

from app.db.session import Base


class AiResultCache(Base):
    """Memoizes one AI tool call's result against a hash of everything that produced it.

    Exists because screening has to be reproducible: re-uploading the same resume to the
    same job must yield the same score, or HR can't defend a decision and a candidate can
    silently cross a bucket threshold between two identical uploads. Temperature 0
    (services/openai_client.py) removes most of that drift but is explicitly not a
    determinism guarantee from the API, so the only way to make it exact is to not ask
    twice.

    The key covers the full input — profile, job criteria, model, and a prompt version —
    so anything that *should* change the answer misses the cache and re-scores. Entries are
    therefore immutable and safe to keep: a stale row is unreachable rather than wrong.
    """

    __tablename__ = "ai_result_cache"

    cache_key = Column(String(64), primary_key=True)
    # What the call was for (e.g. "score", "parse") — not part of the key, which is already
    # namespaced; kept so a human reading the table or clearing one feature's entries can
    # tell the rows apart.
    kind = Column(String(32), nullable=False, index=True)
    result = Column(JSON, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
