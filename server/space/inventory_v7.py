"""Upgrade wire-compatible inventory v7 resources to palette-aware v8."""
from __future__ import annotations

from google.protobuf.message import DecodeError

from space.contracts import inventory_pb2
from space.inventory_codec import (
    SCHEMA_VERSION,
    InventoryCodecError,
    decode_inventory_resource,
    encode_inventory_resource,
    inventory_content_digest,
)


def convert_v7_inventory_resource(encoded: bytes) -> tuple[str, dict, bytes, bytes]:
    """Return ``(kind, portable, canonical_v8_bytes, name_free_digest)``."""
    resource = inventory_pb2.InventoryResource()
    try:
        resource.ParseFromString(encoded)
    except DecodeError as error:
        raise InventoryCodecError("legacy v7 resource is not valid Protobuf") from error
    if resource.schema_version != 7:
        raise InventoryCodecError(
            f"expected legacy schema version 7, got {resource.schema_version}"
        )

    content = resource.WhichOneof("content")
    if content is None:
        raise InventoryCodecError("legacy v7 resource does not contain an inventory item")
    if content == "color_set":
        if resource.color_set.entries:
            raise InventoryCodecError("legacy v7 color set unexpectedly contains v8 entries")
        for color in resource.color_set.legacy_colors:
            entry = resource.color_set.entries.add()
            stop = entry.stops.add()
            stop.color_rgb = int(color)
            stop.offset_millis = 0
            entry.material_id = 0
        resource.color_set.ClearField("legacy_colors")

    resource.schema_version = SCHEMA_VERSION
    upgraded = resource.SerializeToString(deterministic=True)
    kind, portable = decode_inventory_resource(upgraded)
    canonical = encode_inventory_resource(kind, portable)
    digest = inventory_content_digest(kind, portable)
    return kind, portable, canonical, digest
