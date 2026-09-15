"""System metrics collection service for Space.

Monitors real-time online player count, server load (CPU, memory, load average),
and average user latency. Samples and aggregates data minute-by-minute, preserving
a 24-hour historical window (1,440 data points) with multi-tier storage
(process-local minute buffers, shared Redis counters, and database history).
"""
from __future__ import annotations

import asyncio
import collections
import datetime
import json
import logging
import os
import threading
import time
import uuid
from typing import Any, Optional

try:
    import psutil
except ImportError:
    psutil = None

from sqlalchemy import func
from sqlalchemy.orm import Session
from config import settings
from space.database import SessionLocal, engine
from space import models

logger = logging.getLogger("space.metrics")

MAX_HISTORY_MINUTES = 1440  # 24 hours * 60 minutes
RANGE_LIMITS = {
    "1h": 60,
    "6h": 360,
    "12h": 720,
    "24h": 1440,
}


class MetricsCollector:
    def __init__(self, max_history_minutes: int = MAX_HISTORY_MINUTES, redis_client=None) -> None:
        self.max_history_minutes = max_history_minutes
        self._history: collections.deque[dict[str, Any]] = collections.deque(maxlen=max_history_minutes)
        self._lock = threading.Lock()
        self._start_time = time.time()
        self._task: Optional[asyncio.Task] = None
        self._running = False

        self._source_id = uuid.uuid4().hex
        self._redis_client = redis_client
        self._latency_buckets: dict[int, tuple[float, int]] = {}
        self._pending_buckets: set[int] = set()
        self._pending_history: set[int] = set()
        self._flush_lock = threading.Lock()

        # Cached latest server load
        self._last_cpu_percent: float = 0.0

    def record_latency(self, rtt_ms: float) -> None:
        """Record an observed client round-trip latency sample in milliseconds."""
        if not isinstance(rtt_ms, (int, float)):
            return
        if not (0.5 <= rtt_ms <= 120000.0):
            return

        bucket = int(time.time() // 60)
        with self._lock:
            total, count = self._latency_buckets.get(bucket, (0.0, 0))
            self._latency_buckets[bucket] = (total + float(rtt_ms), count + 1)
            self._pending_buckets.add(bucket)
            cutoff = bucket - self.max_history_minutes
            for old in [key for key in self._latency_buckets if key < cutoff]:
                self._latency_buckets.pop(old, None)
                self._pending_buckets.discard(old)
                self._pending_history.discard(old)

    def _redis(self):
        if self._redis_client is not None:
            return self._redis_client
        from space.main import redis
        return redis

    def _flush_latency(self) -> set[int]:
        # Each source publishes cumulative counters. The Lua comparison makes
        # retries (including a lost acknowledgement) and delayed writes idempotent.
        script = """
        local previous = redis.call('HGET', KEYS[1], ARGV[1])
        if not previous or cjson.decode(previous)[2] < tonumber(ARGV[3]) then
            redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
        end
        redis.call('EXPIRE', KEYS[1], 172800)
        return 1
        """
        flushed = set()
        with self._flush_lock:
            with self._lock:
                pending = {key: self._latency_buckets[key] for key in self._pending_buckets}
            for bucket, values in pending.items():
                try:
                    result = self._redis().eval(script, 1, f"space:metrics:latency:{bucket}",
                                                self._source_id, json.dumps(values), values[1])
                    if not isinstance(result, int) or result != 1:
                        raise ValueError("Invalid metrics cache acknowledgement")
                except Exception:
                    continue  # Keep the original minute until it can be published.
                flushed.add(bucket)
                with self._lock:
                    if bucket < int(time.time() // 60):
                        self._pending_history.add(bucket)
                    if self._latency_buckets.get(bucket) == values:
                        self._pending_buckets.discard(bucket)
        return flushed

    def _latency_for(self, bucket: int) -> tuple[float, int, bool]:
        try:
            values = self._redis().hgetall(f"space:metrics:latency:{bucket}")
            if not isinstance(values, dict):
                raise ValueError("Invalid metrics cache response")
            samples = [json.loads(raw) for raw in values.values()]
            return sum(v[0] for v in samples), sum(v[1] for v in samples), True
        except Exception:
            with self._lock:
                total, count = self._latency_buckets.get(bucket, (0.0, 0))
            return total, count, False

    def get_realtime_load(self) -> dict[str, Any]:
        """Read system CPU, RAM, and load averages."""
        cpu = 0.0
        mem_percent = 0.0
        mem_used_mb = 0.0
        mem_total_mb = 0.0

        if psutil is not None:
            try:
                cpu = psutil.cpu_percent(interval=None)
                if cpu == 0.0 and self._last_cpu_percent > 0:
                    cpu = self._last_cpu_percent
                else:
                    self._last_cpu_percent = cpu
                vmem = psutil.virtual_memory()
                mem_percent = round(vmem.percent, 1)
                mem_used_mb = round(vmem.used / (1024 * 1024), 1)
                mem_total_mb = round(vmem.total / (1024 * 1024), 1)
            except Exception as exc:
                logger.debug("Failed reading psutil stats: %s", exc)

        load_1m, load_5m, load_15m = 0.0, 0.0, 0.0
        if hasattr(os, "getloadavg"):
            try:
                loads = os.getloadavg()
                load_1m = round(loads[0], 2)
                load_5m = round(loads[1], 2)
                load_15m = round(loads[2], 2)
            except Exception:
                pass

        return {
            "cpu_percent": round(cpu, 1),
            "memory_percent": mem_percent,
            "memory_used_mb": mem_used_mb,
            "memory_total_mb": mem_total_mb,
            "load_1m": load_1m,
            "load_5m": load_5m,
            "load_15m": load_15m,
        }

    def get_online_user_count(self, db: Optional[Session] = None) -> int:
        """Count active online players across WebSocket sessions and recent presence."""
        ws_count = 0
        try:
            from routers.space_realtime import realtime_hub
            ws_count = sum(len(sessions) for sessions in realtime_hub.sessions.values())
        except Exception:
            pass

        presence_count = 0
        if db is not None:
            try:
                cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=45)
                presence_count = int(
                    db.query(func.count(models.SpacePlayerSnapshot.user_id.distinct()))
                    .filter(models.SpacePlayerSnapshot.updated_at >= cutoff)
                    .scalar()
                    or 0
                )
            except Exception:
                pass

        return max(ws_count, presence_count)

    def get_active_world_count(self) -> int:
        try:
            from routers.space_realtime import realtime_hub
            return len(realtime_hub.sessions)
        except Exception:
            return 1

    def capture_snapshot(self, db: Optional[Session] = None, *, bucket: int | None = None) -> dict[str, Any]:
        """Snapshot a completed minute without clearing the following minute."""
        bucket = int(time.time() // 60) - 1 if bucket is None else bucket
        timestamp = datetime.datetime.fromtimestamp(bucket * 60, datetime.timezone.utc)
        load = self.get_realtime_load()
        total, count, shared = self._latency_for(bucket)
        return {
            "minute_bucket": bucket,
            "timestamp": timestamp.isoformat(),
            "datetime": timestamp.strftime("%Y-%m-%d %H:%M:%S"),
            "online_users": self.get_online_user_count(db),
            "cpu_percent": load["cpu_percent"],
            "memory_percent": load["memory_percent"],
            "memory_used_mb": load["memory_used_mb"],
            "memory_total_mb": load["memory_total_mb"],
            "load_1m": load["load_1m"],
            "avg_latency_ms": round(total / count, 1) if count else None,
            "latency_samples": count,
            "_shared": shared,
        }

    def record_minute_snapshot(self, db: Optional[Session] = None, *, bucket: int | None = None) -> dict[str, Any]:
        self._flush_latency()
        record = self.capture_snapshot(db, bucket=bucket)
        shared = record.pop("_shared")
        bucket = record["minute_bucket"]
        # Never replace a global aggregate with one worker's disconnected samples.
        saved = db is not None and shared and self._persist_to_db(record, db)
        with self._lock:
            if not saved:
                self._pending_history.add(bucket)
            else:
                self._pending_history.discard(bucket)
            records = {item["minute_bucket"]: item for item in self._history}
            records[bucket] = record
            self._history.clear()
            self._history.extend(records[key] for key in sorted(records)[-self.max_history_minutes:])
        return record

    def _persist_to_db(self, record: dict[str, Any], db: Session) -> bool:
        # Every worker sees the shared counters. A delayed snapshot with fewer
        # samples must not overwrite a newer aggregate. Upsert also handles two
        # workers inserting the first record for a minute concurrently.
        from sqlalchemy.dialects.postgresql import insert as pg_insert
        from sqlalchemy.dialects.sqlite import insert as sqlite_insert
        table = models.SpaceMonitoringMetric.__table__
        values = {key: value for key, value in record.items() if key in table.c and key != "created_at"}
        values["timestamp"] = datetime.datetime.fromisoformat(record["timestamp"])
        insert = sqlite_insert if db.get_bind().dialect.name == "sqlite" else pg_insert
        statement = insert(table).values(**values)
        statement = statement.on_conflict_do_update(
            index_elements=[table.c.minute_bucket],
            set_={key: statement.excluded[key] for key in values if key != "minute_bucket"},
            where=statement.excluded.latency_samples >= table.c.latency_samples,
        )
        try:
            db.execute(statement)
            cutoff = int(time.time() // 60) - self.max_history_minutes
            db.query(models.SpaceMonitoringMetric).filter(
                models.SpaceMonitoringMetric.minute_bucket < cutoff
            ).delete(synchronize_session=False)
            db.commit()
            return True
        except Exception as exc:
            db.rollback()
            logger.debug("Failed saving monitoring metric to DB: %s", exc)
            return False

    def hydrate_history(self, db: Optional[Session] = None) -> None:
        """Refresh shared history on reads as well as startup in every worker."""
        if db is None:
            return
        try:
            cutoff = int(time.time() // 60) - self.max_history_minutes
            rows = (db.query(models.SpaceMonitoringMetric)
                    .filter(models.SpaceMonitoringMetric.minute_bucket >= cutoff)
                    .order_by(models.SpaceMonitoringMetric.minute_bucket.desc())
                    .limit(self.max_history_minutes).populate_existing().all())
            loaded = []
            for row in reversed(rows):
                item = {column.name: getattr(row, column.name) for column in row.__table__.columns
                        if column.name != "created_at"}
                timestamp = row.timestamp
                if timestamp.tzinfo is None:
                    timestamp = timestamp.replace(tzinfo=datetime.timezone.utc)
                item["timestamp"] = timestamp.isoformat()
                item["datetime"] = timestamp.strftime("%Y-%m-%d %H:%M:%S")
                loaded.append(item)
            with self._lock:
                self._history.clear()
                self._history.extend(loaded)
        except Exception as exc:
            db.rollback()
            logger.debug("Failed loading shared metric history: %s", exc)

    def get_monitoring_data(
        self,
        range_code: str = "24h",
        db: Optional[Session] = None,
    ) -> dict[str, Any]:
        """Return realtime stats, historical point list, and summary calculations."""
        limit = RANGE_LIMITS.get(range_code.lower(), MAX_HISTORY_MINUTES)

        self._flush_latency()
        self.hydrate_history(db)
        current_lat_sum, current_lat_count, _ = self._latency_for(int(time.time() // 60))
        with self._lock:
            all_history = list(self._history)

        # Slice history according to requested range
        sliced_history = all_history[-limit:] if all_history else []

        realtime_load = self.get_realtime_load()
        realtime_online = self.get_online_user_count(db)
        active_worlds = self.get_active_world_count()

        # Compute instant latency
        current_latency_ms: Optional[float] = None
        if current_lat_count > 0:
            current_latency_ms = round(current_lat_sum / current_lat_count, 1)
        elif sliced_history and sliced_history[-1]["avg_latency_ms"] is not None:
            current_latency_ms = sliced_history[-1]["avg_latency_ms"]

        # Calculate 24h summary statistics
        peak_online = max([p["online_users"] for p in sliced_history], default=realtime_online)
        avg_online = (
            round(sum(p["online_users"] for p in sliced_history) / len(sliced_history), 1)
            if sliced_history
            else float(realtime_online)
        )
        latency_values = [
            p["avg_latency_ms"] for p in sliced_history if p.get("avg_latency_ms") is not None
        ]
        avg_lat = round(sum(latency_values) / len(latency_values), 1) if latency_values else (current_latency_ms or 0.0)
        max_lat = max(latency_values, default=(current_latency_ms or 0.0))
        min_lat = min(latency_values, default=(current_latency_ms or 0.0))

        avg_cpu = (
            round(sum(p["cpu_percent"] for p in sliced_history) / len(sliced_history), 1)
            if sliced_history
            else realtime_load["cpu_percent"]
        )
        avg_mem = (
            round(sum(p["memory_percent"] for p in sliced_history) / len(sliced_history), 1)
            if sliced_history
            else realtime_load["memory_percent"]
        )

        now_utc = datetime.datetime.now(datetime.timezone.utc)
        uptime = int(time.time() - self._start_time)

        return {
            "realtime": {
                "online_users": realtime_online,
                "cpu_percent": realtime_load["cpu_percent"],
                "memory_percent": realtime_load["memory_percent"],
                "memory_used_mb": realtime_load["memory_used_mb"],
                "memory_total_mb": realtime_load["memory_total_mb"],
                "load_1m": realtime_load["load_1m"],
                "load_5m": realtime_load["load_5m"],
                "load_15m": realtime_load["load_15m"],
                "current_latency_ms": current_latency_ms,
                "active_worlds": active_worlds,
                "uptime_seconds": uptime,
                "server_time": now_utc.isoformat(),
            },
            "history": sliced_history,
            "summary": {
                "range": range_code,
                "data_points": len(sliced_history),
                "peak_online_users_24h": peak_online,
                "avg_online_users_24h": avg_online,
                "avg_latency_24h": avg_lat,
                "max_latency_24h": max_lat,
                "min_latency_24h": min_lat,
                "avg_cpu_24h": avg_cpu,
                "avg_memory_24h": avg_mem,
            },
        }

    async def _tick_loop(self) -> None:
        last_bucket = None
        while self._running:
            try:
                def collect():
                    nonlocal last_bucket
                    current = int(time.time() // 60)
                    flushed = self._flush_latency()
                    with self._lock:
                        due = set(self._pending_history)
                    due.update(bucket for bucket in flushed if bucket < current)
                    if last_bucket != current:
                        due.add(current - 1)
                    with SessionLocal() as db:
                        for bucket in sorted(due):
                            self.record_minute_snapshot(db, bucket=bucket)
                    last_bucket = current

                await asyncio.to_thread(collect)
                # Publish live counters between minute boundaries so admin reads
                # on another worker see the same sample population.
                await asyncio.sleep(5)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.exception("Error in metrics collector tick: %s", exc)
                await asyncio.sleep(5)

    def start(self) -> None:
        if self._running:
            return
        self._running = True

        # Ensure database tables exist for standalone or test runs
        try:
            models.Base.metadata.create_all(bind=engine, tables=[models.SpaceMonitoringMetric.__table__])
        except Exception:
            pass

        # Hydrate historical data
        try:
            with SessionLocal() as db:
                self.hydrate_history(db)
        except Exception:
            self.hydrate_history(None)

        # Prime psutil CPU reading
        if psutil is not None:
            try:
                psutil.cpu_percent(interval=None)
            except Exception:
                pass

        # Start minute loop
        try:
            loop = asyncio.get_running_loop()
            self._task = loop.create_task(self._tick_loop())
        except RuntimeError:
            pass

    def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            self._task = None


# Global singleton instance
metrics_collector = MetricsCollector()
