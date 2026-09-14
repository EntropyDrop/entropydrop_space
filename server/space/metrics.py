"""System metrics collection service for Space.

Monitors real-time online player count, server load (CPU, memory, load average),
and average user latency. Samples and aggregates data minute-by-minute, preserving
a 24-hour historical window (1,440 data points) with multi-tier storage
(in-memory circular buffer, Redis cache, and database persistence).
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
    def __init__(self, max_history_minutes: int = MAX_HISTORY_MINUTES) -> None:
        self.max_history_minutes = max_history_minutes
        self._history: collections.deque[dict[str, Any]] = collections.deque(maxlen=max_history_minutes)
        self._lock = threading.Lock()
        self._start_time = time.time()
        self._task: Optional[asyncio.Task] = None
        self._running = False

        # Current minute latency accumulator
        self._current_bucket: int = int(time.time() // 60)
        self._latency_sum: float = 0.0
        self._latency_count: int = 0
        self._latency_max: float = 0.0
        self._latency_min: float = 999999.0

        # Cached latest server load
        self._last_cpu_percent: float = 0.0

    def record_latency(self, rtt_ms: float) -> None:
        """Record an observed client round-trip latency sample in milliseconds."""
        if not isinstance(rtt_ms, (int, float)):
            return
        if not (0.5 <= rtt_ms <= 120000.0):
            return

        now_bucket = int(time.time() // 60)
        with self._lock:
            if now_bucket != self._current_bucket:
                # Flush bucket if roll-over happened between ticks
                self._rollover_locked(now_bucket)

            self._latency_sum += float(rtt_ms)
            self._latency_count += 1
            if rtt_ms > self._latency_max:
                self._latency_max = float(rtt_ms)
            if rtt_ms < self._latency_min:
                self._latency_min = float(rtt_ms)

    def _rollover_locked(self, new_bucket: int) -> None:
        """Reset current minute accumulator for a new bucket."""
        self._current_bucket = new_bucket
        self._latency_sum = 0.0
        self._latency_count = 0
        self._latency_max = 0.0
        self._latency_min = 999999.0

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

    def capture_snapshot(self, db: Optional[Session] = None) -> dict[str, Any]:
        """Capture one minute metrics record."""
        now = datetime.datetime.now(datetime.timezone.utc)
        bucket = int(now.timestamp() // 60)

        load = self.get_realtime_load()
        online_users = self.get_online_user_count(db)

        with self._lock:
            sample_count = self._latency_count
            avg_latency = (
                round(self._latency_sum / self._latency_count, 1)
                if self._latency_count > 0
                else None
            )
            # Reset accumulator for next minute
            self._rollover_locked(bucket + 1)

        record = {
            "minute_bucket": bucket,
            "timestamp": now.isoformat(),
            "datetime": now.strftime("%Y-%m-%d %H:%M:%S"),
            "online_users": online_users,
            "cpu_percent": load["cpu_percent"],
            "memory_percent": load["memory_percent"],
            "memory_used_mb": load["memory_used_mb"],
            "memory_total_mb": load["memory_total_mb"],
            "load_1m": load["load_1m"],
            "avg_latency_ms": avg_latency,
            "latency_samples": sample_count,
        }
        return record

    def record_minute_snapshot(self, db: Optional[Session] = None) -> dict[str, Any]:
        """Produce and persist a minute record into in-memory buffer, Redis, and DB."""
        record = self.capture_snapshot(db)

        with self._lock:
            # Replace if same minute, otherwise append
            if self._history and self._history[-1]["minute_bucket"] == record["minute_bucket"]:
                self._history[-1] = record
            else:
                self._history.append(record)

        # 1. Cache to Redis if available
        self._persist_to_redis(record)

        # 2. Persist to Database if available
        if db is not None:
            self._persist_to_db(record, db)

        return record

    def _persist_to_redis(self, record: dict[str, Any]) -> None:
        try:
            from space.main import redis as redis_client
            if redis_client is not None:
                payload = json.dumps(record)
                redis_client.rpush("space:metrics:24h", payload)
                redis_client.ltrim("space:metrics:24h", -self.max_history_minutes, -1)
                redis_client.expire("space:metrics:24h", 86400 * 2)
        except Exception:
            pass

    def _persist_to_db(self, record: dict[str, Any], db: Session) -> None:
        try:
            dt_ts = datetime.datetime.fromisoformat(record["timestamp"])
            existing = (
                db.query(models.SpaceMonitoringMetric)
                .filter(models.SpaceMonitoringMetric.minute_bucket == record["minute_bucket"])
                .first()
            )
            if existing is None:
                item = models.SpaceMonitoringMetric(
                    minute_bucket=record["minute_bucket"],
                    timestamp=dt_ts,
                    online_users=record["online_users"],
                    cpu_percent=record["cpu_percent"],
                    memory_percent=record["memory_percent"],
                    memory_used_mb=record["memory_used_mb"],
                    memory_total_mb=record["memory_total_mb"],
                    load_1m=record["load_1m"],
                    avg_latency_ms=record["avg_latency_ms"],
                    latency_samples=record["latency_samples"],
                )
                db.add(item)
            else:
                existing.online_users = record["online_users"]
                existing.cpu_percent = record["cpu_percent"]
                existing.memory_percent = record["memory_percent"]
                existing.memory_used_mb = record["memory_used_mb"]
                existing.memory_total_mb = record["memory_total_mb"]
                existing.load_1m = record["load_1m"]
                existing.avg_latency_ms = record["avg_latency_ms"]
                existing.latency_samples = record["latency_samples"]

            # Prune records older than 24 hours
            cutoff_bucket = record["minute_bucket"] - self.max_history_minutes
            db.query(models.SpaceMonitoringMetric).filter(
                models.SpaceMonitoringMetric.minute_bucket < cutoff_bucket
            ).delete(synchronize_session=False)

            db.commit()
        except Exception as exc:
            db.rollback()
            logger.debug("Failed saving monitoring metric to DB: %s", exc)

    def hydrate_history(self, db: Optional[Session] = None) -> None:
        """Pre-populate in-memory history from DB or Redis on service startup."""
        loaded: list[dict[str, Any]] = []

        # Try database first
        if db is not None:
            try:
                rows = (
                    db.query(models.SpaceMonitoringMetric)
                    .order_by(models.SpaceMonitoringMetric.minute_bucket.desc())
                    .limit(self.max_history_minutes)
                    .all()
                )
                for row in reversed(rows):
                    loaded.append({
                        "minute_bucket": row.minute_bucket,
                        "timestamp": row.timestamp.isoformat() if row.timestamp else "",
                        "datetime": row.timestamp.strftime("%Y-%m-%d %H:%M:%S") if row.timestamp else "",
                        "online_users": row.online_users,
                        "cpu_percent": row.cpu_percent,
                        "memory_percent": row.memory_percent,
                        "memory_used_mb": row.memory_used_mb,
                        "memory_total_mb": row.memory_total_mb,
                        "load_1m": row.load_1m,
                        "avg_latency_ms": row.avg_latency_ms,
                        "latency_samples": row.latency_samples,
                    })
            except Exception as exc:
                logger.debug("Failed hydrating metrics from DB: %s", exc)

        # Fallback to Redis if DB yielded nothing
        if not loaded:
            try:
                from space.main import redis as redis_client
                if redis_client is not None:
                    raw_items = redis_client.lrange("space:metrics:24h", -self.max_history_minutes, -1)
                    for raw in raw_items:
                        loaded.append(json.loads(raw))
            except Exception:
                pass

        if loaded:
            with self._lock:
                self._history.clear()
                self._history.extend(loaded)
            logger.info("Hydrated %d monitoring metric points", len(loaded))

    def get_monitoring_data(
        self,
        range_code: str = "24h",
        db: Optional[Session] = None,
    ) -> dict[str, Any]:
        """Return realtime stats, historical point list, and summary calculations."""
        limit = RANGE_LIMITS.get(range_code.lower(), MAX_HISTORY_MINUTES)

        with self._lock:
            all_history = list(self._history)
            current_lat_sum = self._latency_sum
            current_lat_count = self._latency_count

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
        """Background coroutine that triggers metric aggregation once every minute."""
        while self._running:
            try:
                # Sleep until next minute boundary
                now = time.time()
                sleep_seconds = max(1.0, 60.0 - (now % 60.0))
                await asyncio.sleep(sleep_seconds)

                if not self._running:
                    break

                # Run database snapshot inside thread pool to avoid blocking event loop
                def _do_snapshot():
                    with SessionLocal() as db:
                        self.record_minute_snapshot(db)

                await asyncio.to_thread(_do_snapshot)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.exception("Error in metrics collector tick: %s", exc)
                await asyncio.sleep(5.0)

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
