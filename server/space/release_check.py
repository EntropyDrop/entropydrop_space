"""Read-only release gates for published worlds and stored entity downloads."""
import argparse
import hashlib
import json
from pathlib import Path

from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory

from space import models
from space.database import SessionLocal
from space.inventory_codec import SCHEMA_VERSION, decode_inventory_resource
from space.worlds import configured_worlds


def check_data(db, required_worlds):
    specs = configured_worlds()
    by_slug = {spec.slug: spec for spec in specs}
    if len({spec.id for spec in specs}) != len(specs):
        raise RuntimeError('Published world IDs are not unique')
    for slug in required_worlds:
        if slug not in by_slug:
            raise RuntimeError(f'Published world is unavailable: {slug}')
        spec = by_slug[slug]
        world = db.query(models.SpaceWorld).filter_by(id=spec.id).first()
        # New worlds are lazily provisioned by bootstrap; do not create one here.
        if world and (world.status != 1 or world.seed != spec.seed
                      or world.terrain_generator_version != spec.terrain_generator_version):
            raise RuntimeError(f'Published world configuration does not match stored data: {slug}')
    entities = db.query(
        models.SpaceWorldEntity.id, models.SpaceWorldEntity.schema_version, models.SpaceWorldEntity.definition,
        models.SpaceWorldEntity.content_digest, models.SpaceWorldEntity.size_bytes,
        models.SpaceWorldEntity.snapshot, models.SpaceWorldEntity.snapshot_digest,
        models.SpaceWorldEntity.snapshot_size_bytes,
    ).yield_per(1)
    count = 0
    for row in entities:
        definition = bytes(row.definition)
        if (row.schema_version != SCHEMA_VERSION or not definition or len(definition) > 8 * 1024 * 1024
                or len(definition) != row.size_bytes
                or hashlib.sha256(definition).digest() != bytes(row.content_digest)):
            raise RuntimeError(f'Entity {row.id} has invalid download metadata')
        try:
            kind, _portable = decode_inventory_resource(definition)
            if kind != 'entity':
                raise ValueError('not an entity')
        except Exception:
            raise RuntimeError(f'Entity {row.id} cannot be decoded by this release') from None
        if row.snapshot is not None:
            snapshot = bytes(row.snapshot)
            if (len(snapshot) > 4 * 1024 * 1024 or len(snapshot) != row.snapshot_size_bytes
                    or hashlib.sha256(snapshot).digest() != bytes(row.snapshot_digest or b'')):
                raise RuntimeError(f'Entity {row.id} has invalid snapshot metadata')
            try:
                if not isinstance(json.loads(snapshot), dict):
                    raise ValueError('not an object')
            except (ValueError, UnicodeDecodeError):
                raise RuntimeError(f'Entity {row.id} has an unreadable snapshot') from None
        elif row.snapshot_size_bytes or row.snapshot_digest is not None:
            raise RuntimeError(f'Entity {row.id} has snapshot metadata without a snapshot')
        count += 1
    return {'worlds_verified': list(required_worlds), 'entity_downloads_verified': count}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-world', action='append', required=True)
    args = parser.parse_args(argv)
    with SessionLocal() as db:
        connection = db.connection()
        if connection.dialect.name == 'postgresql':
            from sqlalchemy import text
            connection.execute(text('SET TRANSACTION READ ONLY'))
        config = Config(str(Path(__file__).with_name('alembic.ini')))
        expected = set(ScriptDirectory.from_config(config).get_heads())
        actual = set(MigrationContext.configure(connection, opts={
            'version_table': 'space_alembic_version',
        }).get_current_heads())
        if actual != expected:
            raise RuntimeError('Space schema is not at this release migration head')
        result = check_data(db, args.require_world)
        db.rollback()
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
