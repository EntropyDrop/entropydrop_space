"""Admin monitoring router for Space.

Exposes real-time online player count, server load (CPU, memory, load average),
and historical user latency distributions over a 24-hour window.
Strictly restricted to users with administrator access.
"""
from typing import Literal
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from rate_limit import limiter, get_authenticated_or_remote_address
from space import auth
from space.database import get_db
from space import models
from space.metrics import metrics_collector

router = APIRouter(prefix="/space/api/v2/admin/monitoring", tags=["space-monitoring"])


@router.get("")
@limiter.limit("30/minute; 2000/hour", key_func=get_authenticated_or_remote_address)
def get_space_monitoring(
    request: Request,
    range: Literal["1h", "6h", "12h", "24h"] = Query(
        "24h",
        description="Time range for historical metrics (1h, 6h, 12h, 24h)",
    ),
    db: Session = Depends(get_db),
    admin: models.User = Depends(auth.get_current_admin),
):
    """Return real-time metrics, historical minute data, and summary stats (Admin only)."""
    return metrics_collector.get_monitoring_data(range_code=range, db=db)
