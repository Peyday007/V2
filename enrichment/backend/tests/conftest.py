import os

os.environ["DATABASE_URL"] = "sqlite://"
os.environ["JWT_SECRET"] = "test-secret"
os.environ["ADMIN_USERNAME"] = "admin"
os.environ["ADMIN_PASSWORD"] = "test-password-123"

import pytest
from fastapi.testclient import TestClient

from app.database import Base, engine, SessionLocal
from app.auth import ensure_bootstrap_admin
from app.main import app


@pytest.fixture()
def db():
    Base.metadata.create_all(engine)
    session = SessionLocal()
    ensure_bootstrap_admin(session)
    yield session
    session.close()
    Base.metadata.drop_all(engine)


@pytest.fixture()
def client(db):
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def admin_headers(client):
    res = client.post(
        "/auth/login", json={"username": "admin", "password": "test-password-123"}
    )
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}
