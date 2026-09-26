"""Migrate immutable market objects from inventory v7 to v8.

Run after Alembic ``space_0009`` while API/worker writers are stopped. The
operation is restart-safe: each database row switches to its new object only
after that object is durably written; the old object is deleted afterwards.
"""
from __future__ import annotations

import argparse
import logging

from space import models
from space.database import SessionLocal
from space.integrations import object_store
from space.inventory_v7 import convert_v7_inventory_resource

logger = logging.getLogger(__name__)
OBJECT_PREFIX = "space-market/resources"


def migrate_market_v8(*, dry_run: bool = False) -> int:
    migrated = 0
    with SessionLocal() as db:
        rows = db.query(models.SpaceMarketResource).filter(
            models.SpaceMarketResource.schema_version == 7
        ).order_by(models.SpaceMarketResource.id).all()
        for resource in rows:
            old_key = resource.object_key
            encoded = object_store.download_from_s3(old_key, is_public=True)
            kind, _portable, canonical, digest = convert_v7_inventory_resource(encoded)
            if kind != resource.kind:
                raise RuntimeError(
                    f"Market resource {resource.id} row kind {resource.kind} does not match {kind}"
                )
            new_key = f"{OBJECT_PREFIX}/{resource.id}/{digest.hex()}.pb"
            if dry_run:
                migrated += 1
                continue

            duplicate = db.query(models.SpaceMarketResource.id).filter(
                models.SpaceMarketResource.content_digest == digest,
                models.SpaceMarketResource.id != resource.id,
            ).first()
            if duplicate:
                raise RuntimeError(
                    f"Market resource {resource.id} upgrades to the same digest as {duplicate[0]}"
                )

            object_store.upload_to_s3(
                canonical,
                new_key,
                is_public=True,
                content_type="application/x-protobuf",
            )
            try:
                resource.schema_version = 8
                resource.content_digest = digest
                resource.object_key = new_key
                resource.size_bytes = len(canonical)
                db.commit()
            except Exception:
                db.rollback()
                object_store.delete_from_s3_strict(new_key, is_public=True)
                raise
            if old_key != new_key:
                try:
                    object_store.delete_from_s3_strict(old_key, is_public=True)
                except Exception:
                    logger.exception("Could not remove migrated v7 market object %s", old_key)
            migrated += 1
    return migrated


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    count = migrate_market_v8(dry_run=args.dry_run)
    print(f"Inventory v8 market migration: {count} resource(s) {'checked' if args.dry_run else 'migrated'}.")


if __name__ == "__main__":
    main()
