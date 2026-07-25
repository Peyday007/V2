import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .auth import ensure_bootstrap_admin
from .config import settings
from .database import SessionLocal
from .routers import auth_routes, businesses, imports

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

app = FastAPI(title="Enrichment Desk API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_routes.router)
app.include_router(imports.router)
app.include_router(businesses.router)


@app.on_event("startup")
def bootstrap():
    db = SessionLocal()
    try:
        ensure_bootstrap_admin(db)
    finally:
        db.close()


@app.get("/health")
def health():
    return {"status": "ok"}
