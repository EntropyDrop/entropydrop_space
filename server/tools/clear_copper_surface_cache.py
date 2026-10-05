"""Clear Copper's generated snapshots after updating the development terrain runtime.

Run from server/: python tools/clear_copper_surface_cache.py [--dry-run]
with PYTHONPATH=. and the development API environment.
"""
import argparse
import json

from config import settings
from space import models
from space.database import SessionLocal


def clear_copper_surface_cache(db, environment, world_id, *, dry_run=False):
    if environment.lower() not in {"dev", "development"}:
        raise RuntimeError("Copper surface cache clearing requires the development environment")
    # Generation locks world rows too. Wait for its current publish before
    # clearing so an in-flight build cannot restore an old snapshot afterward.
    world = db.query(models.SpaceWorld).filter(
        models.SpaceWorld.id == world_id,
    ).with_for_update().first()
    if world is None or world.terrain_generator_version != 2:
        raise RuntimeError("The configured development Copper world is missing or has another generator")
    snapshots = db.query(models.SpaceSurfaceZoneSnapshot).filter(
        models.SpaceSurfaceZoneSnapshot.world_id == world.id,
    )
    count = snapshots.count() if dry_run else snapshots.delete(synchronize_session=False)
    db.commit()
    return {"world_id": str(world.id), "snapshots": count, "dry_run": dry_run}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    with SessionLocal() as db:
        print(json.dumps(clear_copper_surface_cache(
            db, settings.ENVIRONMENT, settings.SPACE_COPPER_METROPOLIS_WORLD_ID,
            dry_run=args.dry_run,
        )))


if __name__ == "__main__":
    main()
