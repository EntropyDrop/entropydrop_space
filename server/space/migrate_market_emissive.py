"""Migrate immutable market objects from legacy emissive ID (1) to 50% glow (151).

Run after Alembic ``space_0013`` while API/worker writers are stopped. The
operation is restart-safe and idempotent: objects without legacy material ID 1
are skipped, each migrated database row switches to its new object only after
that object is durably written, and the old object is deleted afterwards.
"""
from __future__ import annotations

import argparse
import logging
from typing import Any

from space import models
from space.database import SessionLocal
from space.integrations import object_store
from space.inventory_codec import (
    SCHEMA_VERSION,
    decode_inventory_resource,
    encode_inventory_resource,
    inventory_content_digest,
)

logger = logging.getLogger(__name__)
OBJECT_PREFIX = "space-market/resources"
LEGACY_EMISSIVE = 1
CANONICAL_EMISSIVE = 151


def _migrate_component_materials(component: dict[str, Any]) -> bool:
    changed = False
    for block in component.get("blocks", []):
        if block.get("material_id") == LEGACY_EMISSIVE:
            block["material_id"] = CANONICAL_EMISSIVE
            changed = True
    for decoration in component.get("decorations", []):
        if decoration.get("materialId") == LEGACY_EMISSIVE:
            decoration["materialId"] = CANONICAL_EMISSIVE
            changed = True
    for child in component.get("children", []):
        if _migrate_component_materials(child):
            changed = True
    return changed


def _migrate_block_set_materials(block_set: dict[str, Any]) -> bool:
    changed = False
    for block in block_set.get("blocks", []):
        if block.get("material_id") == LEGACY_EMISSIVE:
            block["material_id"] = CANONICAL_EMISSIVE
            changed = True
    for decoration in block_set.get("decorations", []):
        if decoration.get("materialId") == LEGACY_EMISSIVE:
            decoration["materialId"] = CANONICAL_EMISSIVE
            changed = True
    return changed


def _migrate_portable_materials(kind: str, portable: dict[str, Any]) -> bool:
    if kind == "blockset":
        return _migrate_block_set_materials(portable)
    if kind == "entity":
        return _migrate_component_materials(portable["root"])
    if kind == "colorset":
        changed = False
        for entry in portable.get("entries", []):
            if entry.get("material_id") == LEGACY_EMISSIVE:
                entry["material_id"] = CANONICAL_EMISSIVE
                changed = True
        return changed
    if kind == "item":
        changed = False
        block_set = portable.get("blockSet")
        if isinstance(block_set, dict) and _migrate_block_set_materials(block_set):
            changed = True
        for entity in portable.get("entityList", []):
            if _migrate_component_materials(entity["root"]):
                changed = True
        return changed
    raise RuntimeError(f"Unsupported inventory resource kind {kind}")


def migrate_inventory_resource_emissive(encoded: bytes) -> tuple[str, dict[str, Any], bytes, bytes, bool]:
    kind, portable = decode_inventory_resource(encoded)
    changed = _migrate_portable_materials(kind, portable)
    if not changed:
        return kind, portable, encoded, inventory_content_digest(kind, portable), False
    canonical = encode_inventory_resource(kind, portable)
    digest = inventory_content_digest(kind, portable)
    return kind, portable, canonical, digest, True


def migrate_market_emissive(*, dry_run: bool = False) -> int:
    migrated = 0
    with SessionLocal() as db:
        rows = db.query(models.SpaceMarketResource).filter(
            models.SpaceMarketResource.schema_version == SCHEMA_VERSION
        ).order_by(models.SpaceMarketResource.id).all()
        for resource in rows:
            old_key = resource.object_key
            encoded = object_store.download_from_s3(old_key, is_public=True)
            kind, _portable, canonical, digest, changed = migrate_inventory_resource_emissive(encoded)
            if kind != resource.kind:
                raise RuntimeError(
                    f"Market resource {resource.id} row kind {resource.kind} does not match {kind}"
                )
            if not changed:
                continue
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
                    f"Market resource {resource.id} migrates to the same digest as {duplicate[0]}"
                )

            object_store.upload_to_s3(
                canonical,
                new_key,
                is_public=True,
                content_type="application/x-protobuf",
            )
            try:
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
                    logger.exception("Could not remove migrated emissive market object %s", old_key)
            migrated += 1
    return migrated


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    count = migrate_market_emissive(dry_run=args.dry_run)
    print(f"Emissive market migration: {count} resource(s) {'checked' if args.dry_run else 'migrated'}.")


if __name__ == "__main__":
    main()
