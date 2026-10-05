"""Canonical Protobuf codec for portable Space and market resources."""

from __future__ import annotations

import hashlib
from typing import Any, Literal

from google.protobuf.message import DecodeError

from space.contracts import inventory_pb2
from space.decorations import normalize_decorations as _normalize_decorations


from space.voxel_grid import MICRO_DIVISIONS

SCHEMA_VERSION = 8
InventoryKind = Literal["item", "blockset", "entity", "colorset"]


class InventoryCodecError(ValueError):
    pass


def normalize_decorations(value):
    try:
        return _normalize_decorations(value)
    except (ValueError, TypeError) as error:
        raise InventoryCodecError(str(error)) from error


def _canonical_double(value: Any) -> float:
    """Return the unique protobuf representation for either signed zero."""
    number = float(value)
    return 0.0 if number == 0.0 else number


_BODY_TYPE_TO_PROTO = {
    "dynamic": inventory_pb2.BODY_TYPE_DYNAMIC,
    "kinematic": inventory_pb2.BODY_TYPE_KINEMATIC,
}
_BODY_TYPE_FROM_PROTO = {value: key for key, value in _BODY_TYPE_TO_PROTO.items()}
_CONSTRAINT_TO_PROTO = {
    "point": inventory_pb2.CONSTRAINT_TYPE_POINT,
    "hinge": inventory_pb2.CONSTRAINT_TYPE_HINGE,
    "weld": inventory_pb2.CONSTRAINT_TYPE_WELD,
}
_CONSTRAINT_FROM_PROTO = {value: key for key, value in _CONSTRAINT_TO_PROTO.items()}


def _set_vector(target, value: list[float] | tuple[float, float, float] | None) -> None:
    if value is None:
        return
    target.x = _canonical_double(value[0])
    target.y = _canonical_double(value[1])
    target.z = _canonical_double(value[2])


def _vector(value) -> list[float]:
    return [
        _canonical_double(value.x),
        _canonical_double(value.y),
        _canonical_double(value.z),
    ]


def _set_quaternion(
    target,
    value: list[float] | tuple[float, float, float, float] | None,
) -> None:
    if value is None:
        return
    target.x = _canonical_double(value[0])
    target.y = _canonical_double(value[1])
    target.z = _canonical_double(value[2])
    target.w = _canonical_double(value[3])


def _quaternion(value) -> list[float]:
    return [
        _canonical_double(value.x),
        _canonical_double(value.y),
        _canonical_double(value.z),
        _canonical_double(value.w),
    ]


def _micro_offset(value: Any, axis: str) -> int:
    offset = int(value)
    if not 0 <= offset < MICRO_DIVISIONS:
        raise InventoryCodecError(
            f"micro voxel {axis} offset must be an integer in 0..{MICRO_DIVISIONS - 1}"
        )
    return offset


def _material_id(value: Any) -> int:
    material_id = int(value)
    if material_id not in (0, 1):
        raise InventoryCodecError("voxel material_id must be 0 (default) or 1 (emissive)")
    return material_id


def _encode_voxel(target, block: dict[str, Any]) -> None:
    target.dx = int(block["dx"])
    target.dy = int(block["dy"])
    target.dz = int(block["dz"])
    if block.get("mx") is not None:
        target.is_micro = True
        target.micro_x = _micro_offset(block["mx"], "x")
        target.micro_y = _micro_offset(block["my"], "y")
        target.micro_z = _micro_offset(block["mz"], "z")
    target.color_rgb = int(block["color"])
    target.material_id = _material_id(block.get("material_id", 0))


def _decode_voxel(block) -> dict[str, Any]:
    result: dict[str, Any] = {
        "dx": int(block.dx),
        "dy": int(block.dy),
        "dz": int(block.dz),
        "block": 1,
        "color": int(block.color_rgb),
    }
    if block.is_micro:
        result.update({
            "mx": _micro_offset(block.micro_x, "x"),
            "my": _micro_offset(block.micro_y, "y"),
            "mz": _micro_offset(block.micro_z, "z"),
        })
    material_id = _material_id(block.material_id)
    if material_id:
        result["material_id"] = material_id
    return result


def _voxel_sort_key(block: dict[str, Any]) -> tuple[int, int, int, int, int, int, int, int]:
    return (
        int(block["dx"]),
        int(block["dy"]),
        int(block["dz"]),
        -1 if block.get("mx") is None else int(block["mx"]),
        -1 if block.get("my") is None else int(block["my"]),
        -1 if block.get("mz") is None else int(block["mz"]),
        int(block["color"]),
        _material_id(block.get("material_id", 0)),
    )


def _encode_block_set(message, canonical: dict[str, Any], include_name: bool) -> None:
    if include_name:
        message.name = canonical["name"]
    for block in sorted(canonical["blocks"], key=_voxel_sort_key):
        _encode_voxel(message.blocks.add(), block)


def _decode_block_set(message) -> dict[str, Any]:
    blocks = [_decode_voxel(block) for block in message.blocks]
    return {
        "type": "space-blockset",
        "version": SCHEMA_VERSION,
        "name": message.name,
        "blocks": blocks,
    }


def _encode_color_set(message, canonical: dict[str, Any], include_name: bool) -> None:
    if include_name:
        message.name = canonical["name"]
    for entry in canonical["entries"]:
        encoded_entry = message.entries.add()
        encoded_entry.material_id = _material_id(entry.get("material_id", 0))
        stops = entry.get("stops", [])
        if not 1 <= len(stops) <= 5:
            raise InventoryCodecError("palette entries must contain between 1 and 5 stops")
        previous = -1
        for stop in stops:
            offset = round(float(stop["position"]) * 1000)
            if not 0 <= offset <= 1000 or offset < previous:
                raise InventoryCodecError("gradient stop positions must be sorted within 0..1")
            color = str(stop["color"]).lower()
            if len(color) != 7 or not color.startswith("#"):
                raise InventoryCodecError("gradient stop colors must be #rrggbb values")
            encoded_stop = encoded_entry.stops.add()
            encoded_stop.color_rgb = int(color[1:], 16)
            encoded_stop.offset_millis = offset
            previous = offset


def _decode_color_set(message) -> dict[str, Any]:
    entries = []
    for entry in message.entries:
        if not 1 <= len(entry.stops) <= 5:
            raise InventoryCodecError("palette entries must contain between 1 and 5 stops")
        stops = []
        previous = -1
        for stop in entry.stops:
            offset = int(stop.offset_millis)
            color = int(stop.color_rgb)
            if offset > 1000 or offset < previous:
                raise InventoryCodecError("gradient stop positions must be sorted within 0..1")
            if color > 0xFFFFFF:
                raise InventoryCodecError("gradient stop color is outside 0x000000..0xffffff")
            stops.append({"color": f"#{color:06x}", "position": offset / 1000})
            previous = offset
        entries.append({"stops": stops, "material_id": _material_id(entry.material_id)})
    return {
        "type": "space-colorset",
        "version": SCHEMA_VERSION,
        "name": message.name,
        "entries": entries,
    }


def _encode_body(message, body: dict[str, Any]) -> None:
    message.SetInParent()
    message.type = _BODY_TYPE_TO_PROTO[body.get("type", "dynamic")]
    for field in ("mass", "restitution", "friction"):
        if body.get(field) is not None:
            setattr(message, field, _canonical_double(body[field]))
    for source, target in (
        ("useGravity", "use_gravity"),
        ("collisionEnabled", "collision_enabled"),
    ):
        if body.get(source) is not None:
            setattr(message, target, bool(body[source]))


def _decode_body(message) -> dict[str, Any]:
    result: dict[str, Any] = {
        "type": _enum_value(_BODY_TYPE_FROM_PROTO, message.type, "body type"),
    }
    for field in ("mass", "restitution", "friction"):
        if message.HasField(field):
            result[field] = _canonical_double(getattr(message, field))
    for field, target in (
        ("use_gravity", "useGravity"),
        ("collision_enabled", "collisionEnabled"),
    ):
        if message.HasField(field):
            result[target] = bool(getattr(message, field))
    return result


def _encode_component(message, component: dict[str, Any], include_name: bool) -> None:
    message.id = str(component["id"])
    if include_name:
        message.name = component.get("name", "")
    if component.get("pivot") is not None:
        _set_vector(message.pivot, component["pivot"])
    _encode_body(message.body, component.get("body", {}))
    for block in sorted(component.get("blocks", []), key=_voxel_sort_key):
        _encode_voxel(message.blocks.add(), block)
    if component.get("script") is not None:
        message.script = str(component["script"]) if component.get("scriptLanguage") == "assemblyscript" else ""
        message.script_language = "assemblyscript"
    message.script_disabled = bool(component.get("scriptDisabled", False))
    for seat in component.get("seats", []):
        encoded_seat = message.seats.add()
        _set_vector(encoded_seat.position, seat["position"])
        # Identity rider orientation and free look are implicit defaults, so
        # omitting them keeps every pre-orientation seat byte-identical.
        rotation = seat.get("rotation")
        if rotation is not None and list(rotation) != [0.0, 0.0, 0.0, 1.0]:
            _set_quaternion(encoded_seat.rotation, rotation)
        if seat.get("fixedOrientation") is True:
            encoded_seat.fixed_orientation = True
    for child in sorted(component.get("children", []), key=lambda value: str(value["id"])):
        _encode_component(message.children.add(), child, include_name)
    if component.get("localPosition") is not None:
        _set_vector(message.local_position, component["localPosition"])
    if component.get("localRotation") is not None:
        _set_quaternion(message.local_rotation, component["localRotation"])
    if component.get("anchorRotation") is not None:
        _set_quaternion(message.anchor_rotation, component["anchorRotation"])
    for decoration in normalize_decorations(component.get("decorations", [])):
        encoded = message.decorations.add()
        encoded.id = decoration["id"]
        encoded.color_rgb = decoration["color"]
        encoded.material_id = decoration.get("materialId", 0)
        if "position" in decoration:
            _set_vector(encoded.position, decoration["position"])
        if "rotation" in decoration:
            _set_quaternion(encoded.rotation, decoration["rotation"])
        if "scale" in decoration:
            _set_vector(encoded.scale, decoration["scale"])


def _decode_seat(component_id: str, seat) -> dict[str, Any]:
    if not seat.HasField("position"):
        raise InventoryCodecError(f'component "{component_id}" contains a seat without a position')
    decoded: dict[str, Any] = {"position": _vector(seat.position)}
    if seat.HasField("rotation"):
        decoded["rotation"] = _quaternion(seat.rotation)
    if seat.fixed_orientation:
        decoded["fixedOrientation"] = True
    return decoded


def _decode_component(message) -> dict[str, Any]:
    if not message.HasField("body"):
        raise InventoryCodecError(f'component "{message.id}" is missing its body configuration')
    result: dict[str, Any] = {
        "id": message.id,
        "name": message.name,
        "body": _decode_body(message.body),
        "blocks": [_decode_voxel(block) for block in message.blocks],
        "seats": [_decode_seat(message.id, seat) for seat in message.seats],
        "children": [
            _decode_component(child)
            for child in sorted(message.children, key=lambda value: str(value.id))
        ],
    }
    if message.HasField("pivot"):
        result["pivot"] = _vector(message.pivot)
    if message.HasField("script"):
        result["script"] = message.script if message.script_language == "assemblyscript" else ""
        result["scriptLanguage"] = "assemblyscript"
    if message.script_disabled:
        result["scriptDisabled"] = True
    if message.HasField("local_position"):
        result["localPosition"] = _vector(message.local_position)
    if message.HasField("local_rotation"):
        result["localRotation"] = _quaternion(message.local_rotation)
    if message.HasField("anchor_rotation"):
        result["anchorRotation"] = _quaternion(message.anchor_rotation)
    if message.decorations:
        result["decorations"] = normalize_decorations([{
            "id": decoration.id, "color": decoration.color_rgb,
            "materialId": decoration.material_id,
            **({"position": _vector(decoration.position)} if decoration.HasField("position") else {}),
            **({"rotation": _quaternion(decoration.rotation)} if decoration.HasField("rotation") else {}),
            **({"scale": _vector(decoration.scale)} if decoration.HasField("scale") else {}),
        } for decoration in message.decorations])
    return result


def _encode_entity(message, canonical: dict[str, Any], include_name: bool) -> None:
    if "name" in canonical:
        raise InventoryCodecError("entity names belong to root.name")
    _encode_component(message.root, canonical["root"], include_name)
    for constraint in sorted(canonical.get("constraints", []), key=lambda value: str(value["id"])):
        encoded = message.constraints.add()
        encoded.id = constraint["id"]
        encoded.type = _CONSTRAINT_TO_PROTO[constraint.get("type", "point")]
        if constraint.get("bodyA") is not None:
            encoded.body_a_component_id = constraint["bodyA"]
        encoded.body_b_component_id = constraint["bodyB"]
        for source, target in (
            ("anchorA", "anchor_a"),
            ("anchorB", "anchor_b"),
            ("axisA", "axis_a"),
            ("axisB", "axis_b"),
            ("referenceA", "reference_a"),
            ("referenceB", "reference_b"),
        ):
            if constraint.get(source) is not None:
                _set_vector(getattr(encoded, target), constraint[source])
        if constraint.get("limits") is not None:
            encoded.limits.min = _canonical_double(constraint["limits"]["min"])
            encoded.limits.max = _canonical_double(constraint["limits"]["max"])
        encoded.stiffness = _canonical_double(constraint.get("stiffness", 0.9))
        encoded.collide_connected = bool(constraint.get("collideConnected", False))


def _enum_value(mapping: dict[int, str], value: int, label: str) -> str:
    try:
        return mapping[value]
    except KeyError as error:
        raise InventoryCodecError(f"unknown {label} enum value {value}") from error


def _decode_entity(message) -> dict[str, Any]:
    if not message.HasField("root"):
        raise InventoryCodecError("entity is missing its root component")
    result: dict[str, Any] = {
        "type": "space-entity",
        "version": SCHEMA_VERSION,
        "root": _decode_component(message.root),
        "constraints": [],
    }
    for constraint in sorted(message.constraints, key=lambda value: str(value.id)):
        decoded: dict[str, Any] = {
            "id": constraint.id,
            "type": _enum_value(_CONSTRAINT_FROM_PROTO, constraint.type, "constraint type"),
            "bodyA": (
                constraint.body_a_component_id
                if constraint.HasField("body_a_component_id")
                else None
            ),
            "bodyB": constraint.body_b_component_id,
            "stiffness": _canonical_double(constraint.stiffness),
            "collideConnected": bool(constraint.collide_connected),
        }
        for source, target in (
            ("anchor_a", "anchorA"),
            ("anchor_b", "anchorB"),
            ("axis_a", "axisA"),
            ("axis_b", "axisB"),
            ("reference_a", "referenceA"),
            ("reference_b", "referenceB"),
        ):
            if constraint.HasField(source):
                decoded[target] = _vector(getattr(constraint, source))
        if constraint.HasField("limits"):
            decoded["limits"] = {
                "min": _canonical_double(constraint.limits.min),
                "max": _canonical_double(constraint.limits.max),
            }
        result["constraints"].append(decoded)
    return result


def encode_inventory_resource(
    kind: InventoryKind,
    canonical: dict[str, Any],
    *,
    include_name: bool = True,
) -> bytes:
    resource = inventory_pb2.InventoryResource(schema_version=SCHEMA_VERSION)
    if kind == "item":
        if not isinstance(canonical.get("id"), str) or not canonical["id"].strip():
            raise InventoryCodecError("an Item must have a template id")
        resource.item.SetInParent()
        if include_name:
            resource.item.id = canonical["id"]
            resource.item.name = canonical.get("name", "")
        block_set = canonical.get("blockSet")
        if block_set and block_set.get("blocks"):
            _encode_block_set(resource.item.block_set, block_set, include_name)
        for entity in canonical.get("entityList", []):
            entity = {**entity, "root": {**entity["root"]}}
            root = entity["root"]
            if root.get("localPosition") is not None and all(value == 0 for value in root["localPosition"]):
                root.pop("localPosition")
            if root.get("localRotation") is not None:
                values = [_canonical_double(value) for value in root["localRotation"]]
                first = next((value for value in [values[3], *values[:3]] if value != 0), 0)
                root["localRotation"] = [_canonical_double(value * (-1 if first < 0 else 1)) for value in values]
                if root["localRotation"] == [0, 0, 0, 1]:
                    root.pop("localRotation")
            _encode_entity(resource.item.entity_list.add(), entity, include_name)
    elif kind == "blockset":
        _encode_block_set(resource.block_set, canonical, include_name)
    elif kind == "entity":
        _encode_entity(resource.entity, canonical, include_name)
    elif kind == "colorset":
        _encode_color_set(resource.color_set, canonical, include_name)
    else:
        raise InventoryCodecError(f"unsupported inventory kind {kind}")
    return resource.SerializeToString(deterministic=True)


def decode_inventory_resource(encoded: bytes) -> tuple[InventoryKind, dict[str, Any]]:
    resource = inventory_pb2.InventoryResource()
    try:
        resource.ParseFromString(encoded)
    except DecodeError as error:
        raise InventoryCodecError("resource is not valid Protobuf") from error
    if resource.schema_version != SCHEMA_VERSION:
        raise InventoryCodecError(f"expected schema version {SCHEMA_VERSION}")
    content = resource.WhichOneof("content")
    if content == "item":
        result = {
            "type": "space-item",
            "version": SCHEMA_VERSION,
            "id": resource.item.id,
            "name": resource.item.name,
            "entityList": [_decode_entity(entity) for entity in resource.item.entity_list],
        }
        if resource.item.HasField("block_set") and resource.item.block_set.blocks:
            result["blockSet"] = _decode_block_set(resource.item.block_set)
        return "item", result
    if content == "block_set":
        return "blockset", _decode_block_set(resource.block_set)
    if content == "entity":
        return "entity", _decode_entity(resource.entity)
    if content == "color_set":
        return "colorset", _decode_color_set(resource.color_set)
    raise InventoryCodecError("resource does not contain an inventory item")


def inventory_content_digest(kind: InventoryKind, canonical: dict[str, Any]) -> bytes:
    encoded = encode_inventory_resource(kind, canonical, include_name=False)
    return hashlib.sha256(encoded).digest()


def inventory_resource_name(kind: InventoryKind, canonical: dict[str, Any]) -> str:
    """Derive list metadata without introducing a second entity name source."""
    if kind == "entity":
        root = canonical["root"]
        return root.get("name") or root["id"]
    return canonical["name"]
