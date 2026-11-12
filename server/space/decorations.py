"""Canonical visual-only decoration values; no physics dependencies."""
import math
import re

MAX_DECORATIONS = 1024
MAX_BLOCKSET_DECORATIONS = 4096
MAX_TERRAIN_DECORATIONS_PER_CHUNK = 256
MAX_ANCHORED_EXTENT = 16


def normalize_decoration(value):
    identifier = value.get("id")
    if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", identifier):
        raise ValueError("decoration id must be a portable identifier")
    color = value.get("color", 0)
    material = value.get("materialId", 0)
    if type(color) is not int or not 0 <= color <= 0xFFFFFF:
        raise ValueError("decoration color must be 0xRRGGBB")
    if type(material) is not int or material not in range(102):
        raise ValueError("decoration material must be 0, 1, or 2-101")
    result = {"id": identifier, "color": color}
    if material:
        result["materialId"] = material
    for field, default in (("position", (0, 0, 0)), ("scale", (1, 1, 1))):
        vector = value.get(field)
        if vector is None:
            continue
        if not isinstance(vector, (tuple, list)) or len(vector) != 3 or any(
            type(component) not in (int, float) or not math.isfinite(component) for component in vector
        ):
            raise ValueError(f"decoration {field} must be a finite 3D vector")
        if field == "position" and any(abs(component) > 512 for component in vector):
            raise ValueError("decoration position must be within ±512")
        if field == "scale" and any(component <= 0 or component > 256 for component in vector):
            raise ValueError("decoration dimensions must be positive and at most 256")
        if tuple(vector) != default:
            result[field] = [0.0 if component == 0 else float(component) for component in vector]
    rotation = value.get("rotation")
    if rotation is not None:
        if not isinstance(rotation, (tuple, list)) or len(rotation) != 4 or any(
            type(component) not in (int, float) or not math.isfinite(component) for component in rotation
        ):
            raise ValueError("decoration rotation must be a finite unit quaternion")
        length_sq = sum(component * component for component in rotation)
        if abs(length_sq - 1) > 1e-6:
            raise ValueError("decoration rotation must be a unit quaternion")
        length = math.sqrt(length_sq) if abs(length_sq - 1) > 1e-12 else 1
        first = next(component for component in (rotation[3], *rotation[:3]) if component != 0)
        sign = -1 if first < 0 else 1
        rotation = [0.0 if component == 0 else component / length * sign for component in rotation]
        if rotation != [0, 0, 0, 1]:
            result["rotation"] = rotation
    return result


def normalize_decorations(values):
    if not isinstance(values, list) or len(values) > MAX_DECORATIONS:
        raise ValueError(f"at most {MAX_DECORATIONS} decorations are allowed")
    result = [normalize_decoration(value) for value in values]
    if len({value["id"] for value in result}) != len(result):
        raise ValueError("decoration ids must be unique within a component")
    return sorted(result, key=lambda value: value["id"])


def _bounded_anchored(result):
    if any(abs(component) > MAX_ANCHORED_EXTENT for component in result.get("position", ())):
        raise ValueError(f"anchored decoration offset must be within ±{MAX_ANCHORED_EXTENT}")
    if any(component > MAX_ANCHORED_EXTENT for component in result.get("scale", ())):
        raise ValueError(f"anchored decoration dimensions must be at most {MAX_ANCHORED_EXTENT}")
    return result


def _integer_cell(value, keys, label):
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    cell = tuple(value.get(key) for key in keys)
    if any(type(component) is not int for component in cell):
        raise ValueError(f"{label} must be an integer voxel cell")
    return cell


def normalize_anchored_decoration(value):
    """A BlockSet decoration: standard anchor cell plus offset from its centre."""
    dx, dy, dz = _integer_cell(value, ("dx", "dy", "dz"), "anchored decoration anchor")
    result = _bounded_anchored(normalize_decoration({**value, "id": "anchored"}))
    result.pop("id")
    return {"dx": dx, "dy": dy, "dz": dz, **result}


def anchored_sort_key(value):
    return (
        value["dx"], value["dy"], value["dz"],
        *value.get("position", (0, 0, 0)), *value.get("rotation", (0, 0, 0, 1)), *value.get("scale", (1, 1, 1)),
        value["color"], value.get("materialId", 0),
    )


def normalize_anchored_decorations(values, blocks):
    """Canonical BlockSet decorations; each anchor must be one of its standard voxels."""
    if values is None:
        return []
    if not isinstance(values, list) or len(values) > MAX_BLOCKSET_DECORATIONS:
        raise ValueError(f"at most {MAX_BLOCKSET_DECORATIONS} anchored decorations are allowed")
    result = sorted((normalize_anchored_decoration(value) for value in values), key=anchored_sort_key)
    standard = {
        (int(block["dx"]), int(block["dy"]), int(block["dz"]))
        for block in blocks if block.get("mx") is None
    }
    for value in result:
        if (value["dx"], value["dy"], value["dz"]) not in standard:
            raise ValueError("each block-set decoration must be anchored to one of its standard voxels")
    return result


def normalize_terrain_decoration(value):
    """Terrain overlay form: world anchor cell, chunk-unique id and terrain field names."""
    x, y, z = _integer_cell(value, ("x", "y", "z"), "terrain decoration anchor")
    portable = {key: item for key, item in value.items() if key not in ("x", "y", "z", "material", "kind")}
    if value.get("material") is not None:
        portable["materialId"] = value["material"]
    result = _bounded_anchored(normalize_decoration(portable))
    terrain = {"id": result["id"], "x": x, "y": y, "z": z, "color": result["color"]}
    if result.get("materialId"):
        terrain["material"] = result["materialId"]
    for field in ("position", "rotation", "scale"):
        if field in result:
            terrain[field] = result[field]
    return terrain
