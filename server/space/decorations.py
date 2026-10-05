"""Canonical visual-only decoration values; no physics dependencies."""
import math
import re

MAX_DECORATIONS = 1024


def normalize_decoration(value):
    identifier = value.get("id")
    if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", identifier):
        raise ValueError("decoration id must be a portable identifier")
    color = value.get("color", 0)
    material = value.get("materialId", 0)
    if type(color) is not int or not 0 <= color <= 0xFFFFFF:
        raise ValueError("decoration color must be 0xRRGGBB")
    if type(material) is not int or material not in (0, 1):
        raise ValueError("decoration material must be 0 or 1")
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
