//! Bounded, native surface voxelization. File parsing never mutates the world.
use crate::{protocol, protocol::inventory as pb};
use anyhow::{Context, Result, ensure};
use glam::{DVec2, DVec3};
use std::sync::Arc;
use std::{collections::BTreeMap, path::Path};
#[derive(Clone)]
pub struct Texture {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub flip_y: bool,
}
#[derive(Clone)]
pub struct Triangle {
    pub vertices: [DVec3; 3],
    pub color: u32,
    pub vertex_colors: Option<[DVec3; 3]>,
    pub uvs: Option<[DVec2; 3]>,
    pub texture: Option<Arc<Texture>>,
}
pub fn read_stl(bytes: &[u8], color: u32) -> Result<Vec<Triangle>> {
    ensure!(bytes.len() <= 128 * 1024 * 1024, "Model exceeds 128 MiB");
    let mut triangles = Vec::new();
    let count = bytes
        .get(80..84)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()) as usize);
    if let Some(count) = count.filter(|n| 84 + n * 50 == bytes.len()) {
        ensure!(count <= 3_000_000, "Model exceeds 3 million triangles");
        for i in 0..count {
            let start = 84 + i * 50;
            let mut vertices = [DVec3::ZERO; 3];
            for (v, p) in vertices.iter_mut().enumerate() {
                for axis in 0..3 {
                    let offset = start + 12 + v * 12 + axis * 4;
                    p[axis] =
                        f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as f64;
                }
            }
            let attribute = u16::from_le_bytes(bytes[start + 48..start + 50].try_into().unwrap());
            let rgb = if attribute & 0x8000 != 0 {
                let expand = |n: u16| u32::from((n << 3) | (n >> 2));
                (expand((attribute >> 10) & 31) << 16)
                    | (expand((attribute >> 5) & 31) << 8)
                    | expand(attribute & 31)
            } else {
                color
            };
            triangles.push(Triangle {
                vertices,
                color: rgb,
                vertex_colors: None,
                uvs: None,
                texture: None,
            });
        }
    } else {
        let text = std::str::from_utf8(bytes).context("Invalid STL encoding")?;
        let mut points = Vec::new();
        for line in text.lines() {
            let mut parts = line.split_whitespace();
            if parts.next() != Some("vertex") {
                continue;
            }
            let mut p = DVec3::ZERO;
            for axis in 0..3 {
                p[axis] = parts.next().context("Incomplete STL vertex")?.parse()?;
            }
            points.push(p);
            ensure!(
                points.len() <= 9_000_000,
                "Model exceeds 3 million triangles"
            );
        }
        ensure!(points.len() % 3 == 0, "Incomplete STL triangle");
        for v in points.as_chunks::<3>().0 {
            triangles.push(Triangle {
                vertices: [v[0], v[1], v[2]],
                color,
                vertex_colors: None,
                uvs: None,
                texture: None,
            });
        }
    }
    ensure!(!triangles.is_empty(), "Model contains no triangles");
    ensure!(
        triangles
            .iter()
            .all(|t| t.vertices.iter().all(|v| v.is_finite())),
        "Model contains non-finite vertices"
    );
    Ok(triangles)
}
pub fn voxelize(
    triangles: &[Triangle],
    size: u32,
    micro: bool,
    material: u32,
    name: &str,
) -> Result<pb::InventoryResource> {
    ensure!((1..=256).contains(&size), "Model size must be 1–256 cells");
    let min = triangles
        .iter()
        .flat_map(|t| t.vertices)
        .fold(DVec3::splat(f64::INFINITY), DVec3::min);
    let max = triangles
        .iter()
        .flat_map(|t| t.vertices)
        .fold(DVec3::splat(f64::NEG_INFINITY), DVec3::max);
    ensure!(
        (max - min).max_element() > 1e-12,
        "Model has no volume or surface"
    );
    let scale = (size as f64 * if micro { 8.0 } else { 1.0 } - 0.001) / (max - min).max_element();
    let mut cells = BTreeMap::new();
    let mut work = 0usize;
    for triangle in triangles {
        let v = triangle.vertices.map(|p| (p - min) * scale);
        let low = v
            .into_iter()
            .fold(DVec3::splat(f64::INFINITY), DVec3::min)
            .floor()
            .as_ivec3();
        let high = v
            .into_iter()
            .fold(DVec3::splat(f64::NEG_INFINITY), DVec3::max)
            .floor()
            .as_ivec3();
        let count = (high - low + glam::IVec3::ONE).as_i64vec3();
        work = work.saturating_add((count.x * count.y * count.z) as usize);
        ensure!(
            work <= 64_000_000,
            "Model is too complex at this resolution; reduce size"
        );
        for z in low.z..=high.z {
            for y in low.y..=high.y {
                for x in low.x..=high.x {
                    let center = DVec3::new(x as f64 + 0.5, y as f64 + 0.5, z as f64 + 0.5);
                    if intersects(v.map(|p| p - center)) {
                        let weights = barycentric(v, center);
                        let point = v[0] * weights.x + v[1] * weights.y + v[2] * weights.z;
                        let distance = point.distance_squared(center);
                        let entry = cells.entry((x, y, z)).or_insert((f64::INFINITY, 0));
                        if distance < entry.0 {
                            *entry = (distance, sample(triangle, weights));
                        }
                    }
                }
            }
        }
        ensure!(
            cells.len() <= 65536,
            "Model exceeds 65,536 voxels; reduce size"
        );
    }
    let divisor = if micro { 8 } else { 1 };
    let blocks = cells
        .into_iter()
        .map(|((x, y, z), (_, color))| pb::Voxel {
            dx: x / divisor,
            dy: y / divisor,
            dz: z / divisor,
            is_micro: micro,
            micro_x: if micro { (x % 8) as u32 } else { 0 },
            micro_y: if micro { (y % 8) as u32 } else { 0 },
            micro_z: if micro { (z % 8) as u32 } else { 0 },
            color_rgb: color,
            material_id: material,
        })
        .collect();
    let r = pb::InventoryResource {
        schema_version: 8,
        content: Some(pb::inventory_resource::Content::BlockSet(pb::BlockSet {
            name: name.into(),
            blocks,
        })),
    };
    protocol::validate(&r)?;
    Ok(r)
}
fn intersects(v: [DVec3; 3]) -> bool {
    let edges = [v[1] - v[0], v[2] - v[1], v[0] - v[2]];
    let axes = [DVec3::X, DVec3::Y, DVec3::Z];
    for axis in axes
        .into_iter()
        .chain(std::iter::once(edges[0].cross(edges[1])))
        .chain(edges.into_iter().flat_map(|e| axes.map(|a| e.cross(a))))
    {
        let dots = v.map(|p| p.dot(axis));
        let r = axis.abs().element_sum() * 0.5;
        if dots.into_iter().fold(f64::INFINITY, f64::min) > r + 1e-9
            || dots.into_iter().fold(f64::NEG_INFINITY, f64::max) < -r - 1e-9
        {
            return false;
        }
    }
    true
}
pub fn load(
    path: &Path,
    size: u32,
    micro: bool,
    color: u32,
    material: u32,
) -> Result<pb::InventoryResource> {
    let triangles = crate::model_formats::read(path, color)?;
    voxelize(
        &triangles,
        size,
        micro,
        material,
        path.file_stem().and_then(|s| s.to_str()).unwrap_or("Model"),
    )
}
fn barycentric(v: [DVec3; 3], p: DVec3) -> DVec3 {
    let ab = v[1] - v[0];
    let ac = v[2] - v[0];
    let ap = p - v[0];
    let d1 = ab.dot(ap);
    let d2 = ac.dot(ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return DVec3::X;
    }
    let bp = p - v[1];
    let d3 = ab.dot(bp);
    let d4 = ac.dot(bp);
    if d3 >= 0.0 && d4 <= d3 {
        return DVec3::Y;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let t = d1 / (d1 - d3);
        return DVec3::new(1.0 - t, t, 0.0);
    }
    let cp = p - v[2];
    let d5 = ab.dot(cp);
    let d6 = ac.dot(cp);
    if d6 >= 0.0 && d5 <= d6 {
        return DVec3::Z;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let t = d2 / (d2 - d6);
        return DVec3::new(1.0 - t, 0.0, t);
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        let t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        return DVec3::new(0.0, 1.0 - t, t);
    }
    let sum = va + vb + vc;
    if sum.abs() < 1e-15 {
        DVec3::splat(1.0 / 3.0)
    } else {
        DVec3::new(va, vb, vc) / sum
    }
}
pub fn sample(triangle: &Triangle, weights: DVec3) -> u32 {
    let tint = DVec3::new(
        (triangle.color >> 16 & 255) as f64,
        (triangle.color >> 8 & 255) as f64,
        (triangle.color & 255) as f64,
    );
    let mut color = triangle
        .vertex_colors
        .map(|c| c[0] * weights.x + c[1] * weights.y + c[2] * weights.z);
    if let (Some(texture), Some(uvs)) = (&triangle.texture, triangle.uvs) {
        let uv = uvs[0] * weights.x + uvs[1] * weights.y + uvs[2] * weights.z;
        let x = (uv.x.rem_euclid(1.0) * texture.width as f64).floor() as usize;
        let v = if texture.flip_y { 1.0 - uv.y } else { uv.y };
        let y = (v.rem_euclid(1.0) * texture.height as f64).floor() as usize;
        let i = (y * texture.width as usize + x) * 4;
        if texture.rgba.get(i + 3).is_some_and(|a| *a > 10) {
            color = Some(DVec3::new(
                texture.rgba[i] as f64,
                texture.rgba[i + 1] as f64,
                texture.rgba[i + 2] as f64,
            ));
        }
    }
    let color = if let Some(color) = color {
        if triangle.color != 0 && triangle.color != 0xffffff {
            color * tint / 255.0
        } else {
            color
        }
    } else {
        tint
    };
    let c = color
        .clamp(DVec3::ZERO, DVec3::splat(255.0))
        .round()
        .as_uvec3();
    (c.x << 16) | (c.y << 8) | c.z
}
