from fastapi import APIRouter

from app.api.v1 import auth, candidates, interviews, jobs, oauth, signaling

api_router = APIRouter()
api_router.include_router(auth.router)
api_router.include_router(oauth.router)
api_router.include_router(jobs.router)
api_router.include_router(candidates.router)
api_router.include_router(interviews.router)
api_router.include_router(signaling.router)
