"""Compact, revisioned far-surface snapshots for the wrapped Space world."""

import asyncio
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import struct
import subprocess
import threading
import time

import zstandard as zstd
from sqlalchemy import func

from space import models
from space.voxel_grid import MICRO_DIVISIONS
from space.database import SessionLocal
from space.terrain_wasm import get_terrain_kernels


SURFACE_MAGIC = b"EDSZ"
SURFACE_SCHEMA_VERSION = 7
SURFACE_LOD_SCHEMA_VERSION = 7
SURFACE_LOD_SIZES = (2, 4, 8, 16, 32, 64)
SURFACE_SAMPLES_PER_CHUNK_AXIS = 16
SURFACE_RECORD_BYTES = 8
MAX_SURFACE_BYTES = 32 * 1024 * 1024
SURFACE_HEADER_BYTES = 32
SURFACE_CODEC_ZSTD = 1
SURFACE_COLOR = 0x718F61
MIDDLE_COLOR = 0x806B5C
DEEP_COLOR = 0x66707D
SURFACE_JOB_IDLE_SECONDS = 30
RUNTIME_TERRAIN_GENERATORS = {2, 3}

logger = logging.getLogger(__name__)
_generation_thread_lock = threading.Lock()
_generation_thread: threading.Thread | None = None

_GRAD3 = (
    (1, 1, 0), (-1, 1, 0), (1, -1, 0), (-1, -1, 0),
    (1, 0, 1), (-1, 0, 1), (1, 0, -1), (-1, 0, -1),
    (0, 1, 1), (0, -1, 1), (0, 1, -1), (0, -1, -1),
)


class _SimplexNoise3D:
    """Port of simplex-noise 4.x's seeded 3D path used by the browser."""

    def __init__(self, seed: int):
        state = seed
        permutation = list(range(256))
        for index in range(255):
            state = (state * 9301 + 49297) % 233280
            random_value = state / 233280
            swap_index = index + int(random_value * (256 - index))
            permutation[index], permutation[swap_index] = permutation[swap_index], permutation[index]
        self.permutation = permutation + permutation

    def __call__(self, x: float, y: float, z: float) -> float:
        skew = (x + y + z) / 3
        i = math.floor(x + skew)
        j = math.floor(y + skew)
        k = math.floor(z + skew)
        unskew = (i + j + k) / 6
        x0, y0, z0 = x - (i - unskew), y - (j - unskew), z - (k - unskew)

        if x0 >= y0:
            if y0 >= z0:
                i1, j1, k1, i2, j2, k2 = 1, 0, 0, 1, 1, 0
            elif x0 >= z0:
                i1, j1, k1, i2, j2, k2 = 1, 0, 0, 1, 0, 1
            else:
                i1, j1, k1, i2, j2, k2 = 0, 0, 1, 1, 0, 1
        elif y0 < z0:
            i1, j1, k1, i2, j2, k2 = 0, 0, 1, 0, 1, 1
        elif x0 < z0:
            i1, j1, k1, i2, j2, k2 = 0, 1, 0, 0, 1, 1
        else:
            i1, j1, k1, i2, j2, k2 = 0, 1, 0, 1, 1, 0

        offsets = (
            (x0, y0, z0, 0, 0, 0),
            (x0 - i1 + 1 / 6, y0 - j1 + 1 / 6, z0 - k1 + 1 / 6, i1, j1, k1),
            (x0 - i2 + 1 / 3, y0 - j2 + 1 / 3, z0 - k2 + 1 / 3, i2, j2, k2),
            (x0 - 0.5, y0 - 0.5, z0 - 0.5, 1, 1, 1),
        )
        ii, jj, kk = i & 255, j & 255, k & 255
        total = 0.0
        for ox, oy, oz, di, dj, dk in offsets:
            attenuation = 0.6 - ox * ox - oy * oy - oz * oz
            if attenuation < 0:
                continue
            gradient_index = self.permutation[
                ii + di + self.permutation[jj + dj + self.permutation[kk + dk]]
            ] % 12
            gx, gy, gz = _GRAD3[gradient_index]
            attenuation *= attenuation
            total += attenuation * attenuation * (gx * ox + gy * oy + gz * oz)
        return 32 * total


class TerrainSurfaceGenerator:
    def __init__(self, seed: int, width_cells: int, length_cells: int, version: int = 1):
        self.noise = _SimplexNoise3D(seed)
        self.width_cells = width_cells
        self.length_cells = length_cells
        self.major_radius = width_cells / (2 * math.pi)
        self.minor_radius = length_cells / (2 * math.pi)
        self.version = version

    def sample_height(self, world_x: int, world_z: int) -> int:
        theta = (world_x / self.width_cells) * math.tau
        phi = (world_z / self.length_cells) * math.tau
        cos_theta, sin_theta = math.cos(theta), math.sin(theta)
        cos_phi, sin_phi = math.cos(phi), math.sin(phi)
        px = (self.major_radius + self.minor_radius * cos_phi) * cos_theta
        py = (self.major_radius + self.minor_radius * cos_phi) * sin_theta
        pz = self.minor_radius * sin_phi
        broad = self.noise(px * 0.018, py * 0.018, pz * 0.018)
        detail = self.noise(px * 0.052, py * 0.052, pz * 0.052)
        height = math.floor(16 + broad * 3.4 + detail * 1.2 + 0.5)

        spawn_distance = math.hypot(
            world_x - self.width_cells / 2,
            world_z - self.length_cells / 2,
        )
        if spawn_distance < 26:
            blend = max(0.0, min(1.0, (spawn_distance - 10) / 16))
            height = math.floor(16 * (1 - blend) + height * blend + 0.5)
        return max(11, min(21, height))


def _decode_overlay(snapshot: models.SpaceChunkSnapshot) -> dict:
    if snapshot.codec == 0:
        encoded = bytes(snapshot.payload)
    elif snapshot.codec == 1:
        encoded = zstd.ZstdDecompressor().decompress(
            bytes(snapshot.payload),
            max_output_size=int(snapshot.uncompressed_size),
        )
    else:
        raise ValueError("unsupported terrain snapshot codec")
    if (
        len(encoded) != int(snapshot.uncompressed_size)
        or hashlib.sha256(encoded).digest() != bytes(snapshot.content_hash)
    ):
        raise ValueError("terrain snapshot checksum mismatch")
    payload = json.loads(encoded.decode("utf-8"))
    return {
        "standard": payload.get("standard", []),
        "micro": payload.get("micro", []),
    }


def _procedural_color(block_y: int, base_height: int) -> int:
    if block_y == base_height:
        return SURFACE_COLOR
    if block_y >= base_height - 3:
        return MIDDLE_COLOR
    return DEEP_COLOR


def _terrain_runtime_payload(mode: str, seed: int, version: int, x: int, z: int, chunks=None) -> bytes:
    if mode == 'chunks' and (not chunks or len(chunks) > 32):
        raise ValueError('terrain chunk batch must contain 1..32 chunks')
    runtime_dir = Path(__file__).resolve().parent / "space" / "runtime"
    bundled = runtime_dir / "dist" / "terrain-surface.mjs"
    script = bundled if bundled.exists() else runtime_dir / "terrain-surface.ts"
    result = subprocess.run(
        [os.getenv("SPACE_HOSTING_NODE", "node"), str(script), mode,
         str(seed), str(version), str(x), str(z)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        timeout=120,
        input=json.dumps(chunks).encode('utf-8') if mode == 'chunks' else None,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"terrain surface runtime failed: {result.stderr.decode('utf-8', 'replace')[:500]}"
        )
    expected = (512 * 512 * SURFACE_RECORD_BYTES if mode == 'zone' else
                16 * 256 * 16 * 4 * (len(chunks) if mode == 'chunks' else 1))
    if mode == 'volume':
        if not 512 * 512 * 8 + 8 <= len(result.stdout) <= MAX_SURFACE_BYTES:
            raise RuntimeError('voxel surface runtime returned an invalid payload')
    elif len(result.stdout) != expected:
        raise RuntimeError("terrain surface runtime returned an invalid payload")
    return result.stdout


def _terrain_runtime_chunks(seed, version, keys):
    # Bound IPC memory to 8 MiB and amortize Node startup across edited chunks.
    for start in range(0, len(keys), 32):
        batch = keys[start:start + 32]
        data = _terrain_runtime_payload('chunks', seed, version, 0, 0, batch)
        for index in range(len(batch)):
            yield data[index * 262144:(index + 1) * 262144]


def _micro_solid_runs(chunk_x, chunk_z, overlay):
    columns = {}
    for e in overlay.get('micro', []):
        if not isinstance(e, list) or len(e) < 4:
            continue
        x, y, z, color = map(int, e[:4])
        x, z = x - chunk_x * 128, z - chunk_z * 128
        if 0 <= x < 128 and 0 <= z < 128 and 0 <= y < 2048:
            columns.setdefault((x, z), {})[y] = color
    boxes = []
    for (x, z), column in columns.items():
        start = last = -1
        previous = None
        for y, color in sorted(column.items()):
            if y == last + 1 and color == previous:
                last = y
                continue
            if previous is not None:
                boxes.append((x, start, z, 1, last + 1 - start, 1, previous))
            start = last = y
            previous = color
        if previous is not None:
            boxes.append((x, start, z, 1, last + 1 - start, 1, previous))
    return boxes


def _chunk_solid_runs(generator, chunk_x, chunk_z, overlay, procedural_chunk=None):
    """Keep air gaps and color boundaries; merge only identical solid runs.

    Standard columns are exact at 1m. Micro columns retain their 1/8m footprint,
    including cells below a bridge or above an excavated standard cell.
    Render material ids are deliberately omitted: distant LOD always uses the
    default lit material while detailed client chunks restore the stored id.
    """
    edits = {(int(e[0]), int(e[1]), int(e[2])): (int(e[3]), int(e[4]))
             for e in overlay.get('standard', []) if isinstance(e, list) and len(e) >= 5}
    micro_boxes = _micro_solid_runs(chunk_x, chunk_z, overlay)
    kernels = get_terrain_kernels()
    if kernels is not None:
        if procedural_chunk is not None:
            heights = [255] * 256
        elif type(generator) is TerrainSurfaceGenerator:
            lattice = kernels.nature_surface(generator.noise.permutation, chunk_x * 16, chunk_z * 16,
                                             generator.width_cells, generator.length_cells, axis=16)
            heights = [record[0] // 8 - 1 for record in struct.iter_unpack('<HHBBBB', lattice)]
        else:
            heights = [generator.sample_height(chunk_x * 16 + x, chunk_z * 16 + z)
                       for x in range(16) for z in range(16)]
        rows = [(x - chunk_x * 16, y, z - chunk_z * 16, block, color)
                for (x, y, z), (block, color) in edits.items()
                if chunk_x * 16 <= x < (chunk_x + 1) * 16 and chunk_z * 16 <= z < (chunk_z + 1) * 16
                and 0 <= y < 256]
        if (all(0 <= h <= 255 for h in heights)
                and all(0 <= row[3] <= 255 and 0 <= row[4] <= 0xffffff for row in rows)
                and all(0 <= box[6] <= 0xffffff for box in micro_boxes)):
            result = kernels.solid_runs(heights, procedural_chunk, rows, micro_boxes)
            if result is not None:
                return result
    tops = {}
    for (x, y, z) in edits:
        tops[x, z] = max(tops.get((x, z), 0), y)
    boxes = []
    def procedural(x, y, z):
        offset = (x + z * 16 + y * 256) * 4
        block = procedural_chunk[offset]
        color = ((procedural_chunk[offset + 1] << 16)
                 | (procedural_chunk[offset + 2] << 8)
                 | procedural_chunk[offset + 3])
        return (block, color), 255

    for x in range(16):
        for z in range(16):
            wx, wz = chunk_x * 16 + x, chunk_z * 16 + z
            base = (generator.sample_height(wx, wz)
                    if procedural_chunk is None else 255)
            end = min(255, max(base, tops.get((wx, wz), 0)))
            start, previous = 0, None
            for y in range(end + 2):
                if y > 255:
                    base_value = (0, 0)
                elif procedural_chunk is None:
                    base_value = ((1, _procedural_color(y, base))
                                  if y <= base else (0, 0))
                else:
                    base_value = procedural(x, y, z)[0]
                block, color = edits.get((wx, y, wz), base_value)
                color = color if block == 1 and y <= end else None
                if color == previous:
                    continue
                if previous is not None:
                    boxes.append((x * 8, start * 8, z * 8, 8, (y - start) * 8, 8, previous))
                start, previous = y, color
    boxes.extend(micro_boxes)
    # Greedy horizontal merging never crosses an air gap or a colour boundary.
    for axis, width in ((0, 3), (2, 5)):
        groups = {}
        for box in boxes:
            key = tuple(v for i, v in enumerate(box) if i not in (axis, width))
            groups.setdefault(key, []).append(box)
        merged = []
        for group in groups.values():
            current = None
            for box in sorted(group, key=lambda b: b[axis]):
                if current is not None and current[axis] + current[width] == box[axis] and current[width] + box[width] <= 16:
                    current[width] += box[width]
                else:
                    if current is not None:
                        merged.append(tuple(current))
                    current = list(box)
            if current is not None:
                merged.append(tuple(current))
        boxes = merged
    return boxes


def build_surface_zone_payload(world, zone_x, zone_z, source_terrain_revision, overlays=None, voxel_data=None):
    # v6: exact 1m X-major lattice (height, minimum, sRGB, colour error), followed by
    # authored chunk solids. The same solids accompany every mip, so zooming out
    # can never turn a bridge into a pillar or erase a thin build.
    axis = 512
    payload = bytearray(struct.pack('<4sBBBBHHiIQI', SURFACE_MAGIC, 7 if voxel_data is not None else 6, 1, 32, 8,
        zone_x, zone_z, int(world.seed), int(world.terrain_generator_version),
        int(source_terrain_revision), axis * axis))
    version = int(world.terrain_generator_version)
    generator = TerrainSurfaceGenerator(int(world.seed), int(world.width_chunks) * 16,
                                      int(world.length_chunks) * 16, version)
    if voxel_data is not None:
        payload.extend(voxel_data[:axis * axis * 8])
    elif version in RUNTIME_TERRAIN_GENERATORS:
        payload.extend(_terrain_runtime_payload('zone', int(world.seed), version, zone_x, zone_z))
    elif (kernels := get_terrain_kernels()) is not None:
        payload.extend(kernels.nature_surface(generator.noise.permutation,
            zone_x * 512, zone_z * 512, generator.width_cells, generator.length_cells))
    else:
        for x in range(axis):
            for z in range(axis):
                height = (generator.sample_height(zone_x * 512 + x,
                           zone_z * 512 + z) + 1) * MICRO_DIVISIONS
                payload.extend(struct.pack('<HHBBBB', height, height,
                                          0x71, 0x8f, 0x61, 0))
    authored = [(key, value) for key, value in sorted((overlays or {}).items())
                if value.get('standard') or value.get('micro') or value.get('revision')]
    payload.extend(struct.pack('<I', len(authored)))
    procedural_chunks = (_terrain_runtime_chunks(int(world.seed), version, [key for key, _ in authored])
                         if version in RUNTIME_TERRAIN_GENERATORS else None)
    for (cx, cz), overlay in authored:
        procedural_chunk = next(procedural_chunks) if procedural_chunks is not None else None
        boxes = _chunk_solid_runs(generator, cx, cz, overlay, procedural_chunk)
        payload.extend(struct.pack('<BBQI', cx - zone_x * 32, cz - zone_z * 32,
                                   int(overlay.get('revision', 0)), len(boxes)))
        for x, y, z, w, h, d, color in boxes:
            payload.extend(struct.pack('<6H3B', x, y, z, w, h, d,
                            (color >> 16) & 255, (color >> 8) & 255, color & 255))
    if voxel_data is not None:
        payload.extend(voxel_data[axis * axis * 8:])
    if len(payload) > MAX_SURFACE_BYTES:
        raise ValueError('surface snapshot exceeds the authored detail budget')
    return bytes(payload)


def decode_surface_zone_row(row: models.SpaceSurfaceZoneSnapshot) -> bytes:
    if row.codec != SURFACE_CODEC_ZSTD:
        raise ValueError("unsupported surface snapshot codec")
    payload = zstd.ZstdDecompressor().decompress(
        bytes(row.payload),
        max_output_size=int(row.uncompressed_size),
    )
    if (
        len(payload) != int(row.uncompressed_size)
        or hashlib.sha256(payload).digest() != bytes(row.content_hash)
    ):
        raise ValueError("surface snapshot checksum mismatch")
    return payload


def split_voxel_trailer(trailer: bytes):
    """Separate exact authored overlays from the bounded 3D mip ladder."""
    if len(trailer) < 4:
        raise ValueError('truncated voxel trailer')
    count = struct.unpack_from('<I', trailer)[0]
    if count > 1024:
        raise ValueError('invalid authored chunk count')
    offset = 4
    for _ in range(count):
        if offset + 14 > len(trailer):
            raise ValueError('truncated authored chunk')
        offset += 14 + struct.unpack_from('<I', trailer, offset + 10)[0] * 15
    authored = trailer[:offset]
    if trailer[offset:offset + 4] != b'VXL7' or offset + 8 > len(trailer):
        raise ValueError('missing volumetric LOD data')
    count = trailer[offset + 4]
    offset += 8
    levels = []
    for expected in (1, *SURFACE_LOD_SIZES):
        if offset + 8 > len(trailer) or len(levels) >= count:
            raise ValueError('truncated voxel mip ladder')
        size, faces = trailer[offset], struct.unpack_from('<I', trailer, offset + 4)[0]
        end = offset + 8 + faces * 16
        if size != expected or end > len(trailer):
            raise ValueError('invalid voxel mip level')
        levels.append((size, trailer[offset:end]))
        offset = end
    if count != 7 or offset != len(trailer):
        raise ValueError('unexpected voxel trailer')
    return authored, levels


def build_surface_lods(raw: bytes) -> tuple[list[dict], bytes]:
    """Conservative error pyramid; retain authored solids at every data LOD."""
    if len(raw) < SURFACE_HEADER_BYTES:
        raise ValueError('truncated surface source')
    magic, schema, samples, zone_size, record_bytes, *_ = struct.unpack_from('<4sBBBBHHiIQI', raw)
    axis = 512 if schema in (6, 7) and samples == 1 else 256
    end = 32 + axis * axis * record_bytes
    if magic != SURFACE_MAGIC or zone_size != 32 or len(raw) < end:
        raise ValueError('invalid surface source')
    if schema == 3 and samples == 8 and record_bytes == 5 and len(raw) == end:
        grid = [None] * (axis * axis)
        records = struct.iter_unpack('<HBBB', raw[32:])
        for cx in range(32):
            for cz in range(32):
                for sx in range(8):
                    for sz in range(8):
                        h, r, g, b = next(records)
                        grid[(cx * 8 + sx) * axis + cz * 8 + sz] = (h, h, r, g, b, 0)
        trailer = struct.pack('<I', 0)
    elif ((schema == 5 and samples == 2) or (schema in (6, 7) and samples == 1)) and record_bytes == 8 and len(raw) >= end + 4:
        grid = None
        trailer = raw[end:]
    else:
        raise ValueError('invalid surface source')
    voxel_levels = []
    if schema == 7:
        trailer, voxel_levels = split_voxel_trailer(trailer)
    manifest, chunks, offset = [], [], 0
    compressor = zstd.ZstdCompressor(level=6)
    kernels = get_terrain_kernels()
    if kernels is not None:
        records = (raw[32:end] if grid is None else
                   b''.join(struct.pack('<HHBBBB', *record) for record in grid))
        levels = iter(kernels.surface_lods(records, axis))
    else:
        if grid is None:
            grid = list(struct.iter_unpack('<HHBBBB', raw[32:end]))
        levels = None
    for size in SURFACE_LOD_SIZES:
        if size <= 512 // axis:
            continue
        next_axis = axis // 2
        if levels is not None:
            level_size, packed = next(levels)
            if level_size != size:
                raise RuntimeError('Terrain WASM LOD size mismatch')
        else:
            reduced = []
            for x in range(next_axis):
                for z in range(next_axis):
                    children = [grid[(x * 2 + dx) * axis + z * 2 + dz]
                                for dx in range(2) for dz in range(2)]
                    peak = max(children, key=lambda r: r[0])
                    error = min(255, max(c[5] + max(abs(c[i] - peak[i]) for i in (2, 3, 4))
                                         for c in children))
                    reduced.append((peak[0], min(c[1] for c in children), *peak[2:5], error))
            packed = b''.join(struct.pack('<HHBBBB', *record) for record in reduced)
            grid = reduced
        payload = bytearray(raw[:32])
        payload[4:8] = bytes((schema if schema in (6, 7) else 5, size, 32, 8))
        struct.pack_into('<I', payload, 28, next_axis * next_axis)
        payload.extend(packed)
        payload.extend(trailer)
        if schema == 7:
            selected = [data for level_size, data in voxel_levels if level_size >= size]
            payload.extend(b'VXL7' + bytes((len(selected), 0, 0, 0)) + b''.join(selected))
        compressed = compressor.compress(payload)
        manifest.append({'sample_size': size, 'byte_length': len(payload),
            'digest': hashlib.sha256(payload).hexdigest(),
            'offset': offset, 'compressed_size': len(compressed)})
        chunks.append(compressed)
        offset += len(compressed)
        axis = next_axis
    return manifest, b''.join(chunks)


def decode_surface_lod(row: models.SpaceSurfaceZoneSnapshot, level: dict) -> bytes:
    size = int(level['sample_size'])
    expected = int(level['byte_length'])
    minimum = 32 + (512 // size) ** 2 * 5 if size in SURFACE_LOD_SIZES else MAX_SURFACE_BYTES + 1
    start, length = int(level['offset']), int(level['compressed_size'])
    if (not minimum <= expected <= MAX_SURFACE_BYTES or start < 0 or length <= 0
            or row.lod_payload is None or start + length > len(row.lod_payload)):
        raise ValueError('invalid surface LOD metadata')
    payload = zstd.ZstdDecompressor().decompress(
        bytes(row.lod_payload[start:start + length]), max_output_size=expected)
    if len(payload) != expected or hashlib.sha256(payload).hexdigest() != level['digest']:
        raise ValueError('surface LOD checksum mismatch')
    return payload


def generate_surface_zone(db, world: models.SpaceWorld, zone_x: int, zone_z: int):
    zone_size = int(world.zone_size_chunks)
    min_x, min_z = zone_x * zone_size, zone_z * zone_size
    max_x, max_z = min_x + zone_size, min_z + zone_size
    overlay_rows = db.query(models.SpaceChunkSnapshot).filter(
        models.SpaceChunkSnapshot.world_id == world.id,
        models.SpaceChunkSnapshot.chunk_x >= min_x,
        models.SpaceChunkSnapshot.chunk_x < max_x,
        models.SpaceChunkSnapshot.chunk_z >= min_z,
        models.SpaceChunkSnapshot.chunk_z < max_z,
    ).all()
    source_revision = max((int(row.last_event_id or 0) for row in overlay_rows), default=0)
    overlays = {
        (int(row.chunk_x), int(row.chunk_z)): {**_decode_overlay(row), 'revision': int(row.revision)}
        for row in overlay_rows
    }
    volume = _terrain_runtime_payload('volume', int(world.seed), int(world.terrain_generator_version), zone_x, zone_z)
    raw = build_surface_zone_payload(world, zone_x, zone_z, source_revision, overlays, voxel_data=volume)
    lod_manifest, lod_payload = build_surface_lods(raw)
    compressed = zstd.ZstdCompressor(level=6).compress(raw)
    digest = hashlib.sha256(raw).digest()

    row = db.query(models.SpaceSurfaceZoneSnapshot).filter(
        models.SpaceSurfaceZoneSnapshot.world_id == world.id,
        models.SpaceSurfaceZoneSnapshot.zone_x == zone_x,
        models.SpaceSurfaceZoneSnapshot.zone_z == zone_z,
    ).with_for_update().first()
    # Lock the destination before the final source check. Terrain mutation
    # transactions lock the same row before marking it dirty, so an edit can
    # never be silently overwritten by a stale rebuild of an existing zone.
    current_revision = db.query(func.max(models.SpaceChunkSnapshot.last_event_id)).filter(
        models.SpaceChunkSnapshot.world_id == world.id,
        models.SpaceChunkSnapshot.chunk_x >= min_x,
        models.SpaceChunkSnapshot.chunk_x < max_x,
        models.SpaceChunkSnapshot.chunk_z >= min_z,
        models.SpaceChunkSnapshot.chunk_z < max_z,
    ).scalar() or 0
    if int(current_revision) != source_revision:
        db.rollback()
        return None
    if row is None:
        row = models.SpaceSurfaceZoneSnapshot(
            world_id=world.id,
            zone_x=zone_x,
            zone_z=zone_z,
            revision=1,
        )
        db.add(row)
    else:
        row.revision = int(row.revision or 0) + 1
    row.source_terrain_revision = source_revision
    row.terrain_generator_version = int(world.terrain_generator_version)
    row.schema_version = SURFACE_SCHEMA_VERSION
    row.samples_per_chunk_axis = SURFACE_SAMPLES_PER_CHUNK_AXIS
    row.codec = SURFACE_CODEC_ZSTD
    row.uncompressed_size = len(raw)
    row.content_hash = digest
    row.payload = compressed
    row.lod_manifest = lod_manifest
    row.lod_payload = lod_payload
    row.dirty = False
    db.commit()
    db.refresh(row)
    # A first build has no pre-existing row for the mutation transaction to
    # lock. Recheck after publishing it; a concurrent edit either marks the new
    # row itself or is detected here and schedules another rebuild.
    latest_revision = db.query(func.max(models.SpaceChunkSnapshot.last_event_id)).filter(
        models.SpaceChunkSnapshot.world_id == world.id,
        models.SpaceChunkSnapshot.chunk_x >= min_x,
        models.SpaceChunkSnapshot.chunk_x < max_x,
        models.SpaceChunkSnapshot.chunk_z >= min_z,
        models.SpaceChunkSnapshot.chunk_z < max_z,
    ).scalar() or 0
    if int(latest_revision) != source_revision:
        row.dirty = True
        db.commit()
        db.refresh(row)
    return row


def generate_next_surface_zone() -> bool:
    db = SessionLocal()
    try:
        # This lock also makes the API self-healing worker safe alongside the
        # normal Redis-singleton background service and across API replicas.
        worlds = db.query(models.SpaceWorld).filter(
            models.SpaceWorld.status == 1
        ).with_for_update(skip_locked=True).all()
        for world in worlds:
            dirty = db.query(models.SpaceSurfaceZoneSnapshot.zone_x, models.SpaceSurfaceZoneSnapshot.zone_z).filter(
                models.SpaceSurfaceZoneSnapshot.world_id == world.id,
                (
                    (models.SpaceSurfaceZoneSnapshot.dirty.is_(True))
                    | (models.SpaceSurfaceZoneSnapshot.terrain_generator_version != world.terrain_generator_version)
                    | (models.SpaceSurfaceZoneSnapshot.schema_version != SURFACE_SCHEMA_VERSION)
                    | (
                        models.SpaceSurfaceZoneSnapshot.samples_per_chunk_axis
                        != SURFACE_SAMPLES_PER_CHUNK_AXIS
                    )
                    | (models.SpaceSurfaceZoneSnapshot.codec != SURFACE_CODEC_ZSTD)
                    | (models.SpaceSurfaceZoneSnapshot.lod_payload.is_(None))
                ),
            ).order_by(
                models.SpaceSurfaceZoneSnapshot.dirty.desc(),
                # Migrate authored zones first: legacy height maps cannot
                # represent bridges at all, regardless of the pixel budget.
                (models.SpaceSurfaceZoneSnapshot.source_terrain_revision > 0).desc(),
                models.SpaceSurfaceZoneSnapshot.updated_at.asc(),
            ).first()
            if dirty is not None:
                generate_surface_zone(db, world, int(dirty.zone_x), int(dirty.zone_z))
                return True

            existing = {
                (int(row.zone_x), int(row.zone_z))
                # A complete world contains hundreds of MiB of compressed 3D
                # geometry. Residency checks must fetch coordinates only.
                for row in db.query(models.SpaceSurfaceZoneSnapshot.zone_x, models.SpaceSurfaceZoneSnapshot.zone_z).filter(
                    models.SpaceSurfaceZoneSnapshot.world_id == world.id,
                ).all()
            }
            zones_x = int(world.width_chunks) // int(world.zone_size_chunks)
            zones_z = int(world.length_chunks) // int(world.zone_size_chunks)
            pending = [(zone_x, zone_z) for zone_x in range(zones_x)
                       for zone_z in range(zones_z) if (zone_x, zone_z) not in existing]
            if int(world.terrain_generator_version) in RUNTIME_TERRAIN_GENERATORS:
                center_x, center_z = zones_x // 2, zones_z // 2
                pending.sort(key=lambda point: (
                    min(abs(point[0] - center_x), zones_x - abs(point[0] - center_x)) ** 2
                    + min(abs(point[1] - center_z), zones_z - abs(point[1] - center_z)) ** 2
                ))
            if pending:
                generate_surface_zone(db, world, *pending[0])
                return True
        return False
    finally:
        db.close()


def _run_surface_generation_until_current() -> None:
    try:
        while generate_next_surface_zone():
            time.sleep(0.05)
    except Exception:
        logger.exception("Space surface snapshot generation failed")


def ensure_surface_generation_started() -> bool:
    """Start one daemon backfill in this process if another is not running."""
    global _generation_thread
    with _generation_thread_lock:
        if _generation_thread is not None and _generation_thread.is_alive():
            return False
        _generation_thread = threading.Thread(
            target=_run_surface_generation_until_current,
            name="space-surface-snapshot-warmup",
            daemon=True,
        )
        _generation_thread.start()
        return True


async def start_surface_snapshot_job() -> None:
    while True:
        try:
            generated = await asyncio.to_thread(generate_next_surface_zone)
        except Exception:
            logger.exception("Space surface snapshot generation failed; retrying")
            generated = False
        await asyncio.sleep(0.05 if generated else SURFACE_JOB_IDLE_SECONDS)
