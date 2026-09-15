"""Tests for the Space admin monitoring system."""
import time
import json
import pytest
from space.auth import get_current_user
from space.main import app
from space.models import User, SpaceMonitoringMetric
from space.metrics import metrics_collector, MetricsCollector


class SharedMetricsRedis:
    def __init__(self):
        self.hashes = {}
        self.available = True
        self.lose_ack = False

    def eval(self, script, numkeys, key, source, encoded, count):
        if not self.available:
            raise ConnectionError('Redis unavailable')
        values = self.hashes.setdefault(key, {})
        previous = json.loads(values[source]) if source in values else None
        if previous is None or previous[1] < count:
            values[source] = encoded
        if self.lose_ack:
            self.lose_ack = False
            raise ConnectionError('committed but acknowledgement lost')
        return 1

    def hgetall(self, key):
        if not self.available:
            raise ConnectionError('Redis unavailable')
        return dict(self.hashes.get(key, {}))


@pytest.fixture(autouse=True)
def isolated_metrics(monkeypatch):
    cache = SharedMetricsRedis()
    collector = MetricsCollector(redis_client=cache)
    # Existing route tests exercise the process singleton with isolated state.
    monkeypatch.setattr(metrics_collector, '_redis_client', cache)
    monkeypatch.setattr(metrics_collector, '_latency_buckets', {})
    monkeypatch.setattr(metrics_collector, '_pending_buckets', set())
    monkeypatch.setattr(metrics_collector, '_pending_history', set())
    return cache, collector


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


def test_minute_rollover_preserves_old_and_new_samples(db, monkeypatch, isolated_metrics):
    cache, collector = isolated_metrics
    start = 1_800_000_000
    monkeypatch.setattr('space.metrics.time.time', lambda: start + 59.9)
    collector.record_latency(100)
    collector.record_latency(300)
    monkeypatch.setattr('space.metrics.time.time', lambda: start + 60.1)
    collector.record_latency(10)  # Arrives before the background snapshot.
    first = collector.record_minute_snapshot(db)
    assert first['minute_bucket'] == start // 60
    assert first['latency_samples'] == 2 and first['avg_latency_ms'] == 200
    monkeypatch.setattr('space.metrics.time.time', lambda: start + 120.1)
    second = collector.record_minute_snapshot(db)
    assert second['latency_samples'] == 1 and second['avg_latency_ms'] == 10
    assert db.query(SpaceMonitoringMetric).count() == 2


def test_workers_share_aggregates_and_reject_delayed_smaller_snapshots(db, monkeypatch, isolated_metrics):
    cache, first = isolated_metrics
    second = MetricsCollector(redis_client=cache)
    instant = 1_800_000_010
    monkeypatch.setattr('space.metrics.time.time', lambda: instant)
    bucket = instant // 60
    first.record_latency(100)
    first.record_latency(100)
    second.record_latency(300)
    stale = first.record_minute_snapshot(db, bucket=bucket)
    second.record_minute_snapshot(db, bucket=bucket)
    assert first._persist_to_db(stale, db)  # A slow worker arrives after the complete aggregate.
    a, b = first.get_monitoring_data(db=db), second.get_monitoring_data(db=db)
    assert a['history'] == b['history']
    assert a['history'][-1]['latency_samples'] == 3
    assert a['history'][-1]['avg_latency_ms'] == 166.7
    assert a['realtime']['current_latency_ms'] == b['realtime']['current_latency_ms'] == 166.7


def test_cache_retries_are_idempotent_after_a_lost_ack(db, monkeypatch, isolated_metrics):
    cache, collector = isolated_metrics
    instant = 1_800_000_010
    monkeypatch.setattr('space.metrics.time.time', lambda: instant)
    collector.record_latency(100)
    cache.lose_ack = True
    assert collector._flush_latency() == set()
    collector.record_latency(300)
    record = collector.record_minute_snapshot(db, bucket=instant // 60)
    collector.record_minute_snapshot(db, bucket=instant // 60)
    assert record['latency_samples'] == 2 and record['avg_latency_ms'] == 200
    saved = db.query(SpaceMonitoringMetric).one()
    assert saved.latency_samples == 2


def test_cache_outage_retains_prior_minutes_until_recovery(db, monkeypatch, isolated_metrics):
    cache, collector = isolated_metrics
    now = [1_800_000_010]
    monkeypatch.setattr('space.metrics.time.time', lambda: now[0])
    collector.record_latency(100)
    cache.available = False
    now[0] += 60
    collector.record_latency(300)
    old = collector.record_minute_snapshot(db)
    assert db.query(SpaceMonitoringMetric).count() == 0, 'partial local data must not replace global statistics'
    cache.available = True
    now[0] += 60
    collector._flush_latency()
    assert old['minute_bucket'] in collector._pending_history
    for bucket in sorted(collector._pending_history):
        collector.record_minute_snapshot(db, bucket=bucket)
    rows = db.query(SpaceMonitoringMetric).order_by(SpaceMonitoringMetric.minute_bucket).all()
    assert [row.avg_latency_ms for row in rows] == [100, 300]
    assert [row.latency_samples for row in rows] == [1, 1]
