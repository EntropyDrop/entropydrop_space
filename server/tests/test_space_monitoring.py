"""Tests for the Space admin monitoring system."""
import time
from space.auth import get_current_user
from space.main import app
from space.models import User, SpaceMonitoringMetric
from space.metrics import metrics_collector


def _user(db, user_id: str, is_admin: bool = False):
    user = User(
        id=user_id,
        username=f"Tester-{user_id}",
        skin_url="https://cdn.entropydrop.com/skins/tester.png",
        skin_type="slim",
    )
    user.is_admin = is_admin
    db.add(user)
    db.commit()
    db.refresh(user)
    user.is_admin = is_admin  # Ensure in-memory attribute is set
    return user


def test_monitoring_unauthenticated_returns_401(client):
    app.dependency_overrides.pop(get_current_user, None)
    response = client.get("/space/api/v2/admin/monitoring")
    assert response.status_code in (401, 403)


def test_monitoring_non_admin_returns_403(client, db):
    regular_user = _user(db, "space-user-regular", is_admin=False)
    app.dependency_overrides[get_current_user] = lambda: regular_user
    try:
        response = client.get("/space/api/v2/admin/monitoring")
        assert response.status_code == 403
        assert "Administrator access required" in response.text
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_monitoring_admin_returns_200_and_expected_structure(client, db):
    admin_user = _user(db, "space-admin-001", is_admin=True)
    app.dependency_overrides[get_current_user] = lambda: admin_user
    try:
        response = client.get("/space/api/v2/admin/monitoring")
        assert response.status_code == 200
        data = response.json()
        assert "realtime" in data
        assert "history" in data
        assert "summary" in data

        realtime = data["realtime"]
        assert "online_users" in realtime
        assert "cpu_percent" in realtime
        assert "memory_percent" in realtime
        assert "memory_used_mb" in realtime
        assert "memory_total_mb" in realtime
        assert "load_1m" in realtime
        assert "uptime_seconds" in realtime

        summary = data["summary"]
        assert summary["range"] == "24h"
        assert "peak_online_users_24h" in summary
        assert "avg_online_users_24h" in summary
        assert "avg_latency_24h" in summary
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_ping_rtt_records_latency(client, db):
    admin_user = _user(db, "space-admin-002", is_admin=True)
    app.dependency_overrides[get_current_user] = lambda: admin_user
    try:
        # Send a ping with observed RTT
        ping_resp = client.get("/space/api/v2/ping?rtt=38.4")
        assert ping_resp.status_code == 200

        # Query monitoring and verify latency is reflected
        response = client.get("/space/api/v2/admin/monitoring")
        assert response.status_code == 200
        data = response.json()
        current_lat = data["realtime"]["current_latency_ms"]
        assert current_lat is not None
        assert 35.0 <= current_lat <= 45.0
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_monitoring_range_queries(client, db):
    admin_user = _user(db, "space-admin-003", is_admin=True)
    app.dependency_overrides[get_current_user] = lambda: admin_user
    try:
        for r in ("1h", "6h", "12h", "24h"):
            resp = client.get(f"/space/api/v2/admin/monitoring?range={r}")
            assert resp.status_code == 200
            assert resp.json()["summary"]["range"] == r
    finally:
        app.dependency_overrides.pop(get_current_user, None)


def test_record_minute_snapshot_persistence(client, db):
    record = metrics_collector.record_minute_snapshot(db)
    assert record["minute_bucket"] > 0
    assert "cpu_percent" in record
    assert "memory_percent" in record

    # Check database persistence
    saved = (
        db.query(SpaceMonitoringMetric)
        .filter(SpaceMonitoringMetric.minute_bucket == record["minute_bucket"])
        .first()
    )
    assert saved is not None
    assert saved.cpu_percent == record["cpu_percent"]
    assert saved.memory_percent == record["memory_percent"]
