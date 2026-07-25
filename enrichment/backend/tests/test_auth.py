def test_login_success(client):
    res = client.post("/auth/login", json={"username": "admin", "password": "test-password-123"})
    assert res.status_code == 200
    body = res.json()
    assert body["role"] == "admin"
    assert body["token"]


def test_login_wrong_password(client):
    res = client.post("/auth/login", json={"username": "admin", "password": "wrong"})
    assert res.status_code == 401


def test_protected_route_requires_token(client):
    assert client.get("/businesses").status_code == 401


def test_admin_can_create_caller(client, admin_headers):
    res = client.post(
        "/auth/users",
        json={"username": "maria", "password": "caller-pass-1", "role": "caller"},
        headers=admin_headers,
    )
    assert res.status_code == 200
    assert res.json()["role"] == "caller"

    # Caller can log in but cannot create users.
    login = client.post("/auth/login", json={"username": "maria", "password": "caller-pass-1"})
    caller_headers = {"Authorization": f"Bearer {login.json()['token']}"}
    res = client.post(
        "/auth/users",
        json={"username": "x", "password": "password123", "role": "caller"},
        headers=caller_headers,
    )
    assert res.status_code == 403


def test_short_password_rejected(client, admin_headers):
    res = client.post(
        "/auth/users",
        json={"username": "bob", "password": "short", "role": "caller"},
        headers=admin_headers,
    )
    assert res.status_code == 400
