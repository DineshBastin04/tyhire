from app.models.candidate import Bucket
from app.models.job import Job


def bucket_for_score(score: float, job: Job) -> Bucket:
    if score >= job.approve_threshold:
        return Bucket.approved
    if score < job.decline_threshold:
        return Bucket.declined
    return Bucket.review
