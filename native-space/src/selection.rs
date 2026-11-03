//! Deterministic selection geometry, matching the offline Web tools.
use crate::protocol::inventory as pb;
use anyhow::{Result, ensure};
use glam::IVec3;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct ComponentSelection {
    pub entity: String,
    pub component: String,
    pub a: IVec3,
    pub b: IVec3,
    pub micro: bool,
    pub all: bool,
    pub extra: Vec<IVec3>,
}
pub fn partition_voxels(
    blocks: &[pb::Voxel],
    selection: &ComponentSelection,
    shape: SelectionShape,
) -> Result<(Vec<pb::Voxel>, Vec<pb::Voxel>)> {
    if selection.all {
        return Ok((blocks.to_vec(), Vec::new()));
    }
    let mut cells: std::collections::HashSet<_> = shape
        .cells(selection.a, selection.b, 262144)?
        .into_iter()
        .collect();
    cells.extend(selection.extra.iter().copied());
    let mut selected = Vec::new();
    let mut remaining = Vec::new();
    for block in blocks {
        let base = IVec3::new(block.dx, block.dy, block.dz);
        if selection.micro && !block.is_micro {
            let mut inside = Vec::new();
            let mut outside = Vec::new();
            for x in 0..8 {
                for y in 0..8 {
                    for z in 0..8 {
                        let p = base * 8 + IVec3::new(x, y, z);
                        let v = pb::Voxel {
                            is_micro: true,
                            micro_x: x as u32,
                            micro_y: y as u32,
                            micro_z: z as u32,
                            ..*block
                        };
                        if cells.contains(&p) {
                            inside.push(v);
                        } else {
                            outside.push(v);
                        }
                    }
                }
            }
            if inside.is_empty() {
                remaining.push(*block);
            } else {
                selected.extend(inside);
                remaining.extend(outside);
            }
        } else {
            let p = if selection.micro {
                base * 8
                    + IVec3::new(
                        block.micro_x as i32,
                        block.micro_y as i32,
                        block.micro_z as i32,
                    )
            } else {
                base
            };
            if cells.contains(&p) {
                selected.push(*block);
            } else {
                remaining.push(*block);
            }
        }
        ensure!(
            selected.len() + remaining.len() <= 65536,
            "Micro selection exceeds 65,536 component voxels"
        );
    }
    Ok((selected, remaining))
}

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shape {
    #[default]
    Box,
    Cylinder,
    Sphere,
    Stairs,
    Line,
}
impl Shape {
    pub const ALL: [Self; 5] = [
        Self::Box,
        Self::Cylinder,
        Self::Sphere,
        Self::Stairs,
        Self::Line,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Box => "Box",
            Self::Cylinder => "Cylinder",
            Self::Sphere => "Sphere",
            Self::Stairs => "Stairs",
            Self::Line => "Line",
        }
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Stairs {
    pub run: usize,
    pub rise: usize,
    pub run_direction: i32,
    pub rise_direction: i32,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct SelectionShape {
    pub shape: Shape,
    pub cylinder_axis: usize,
    pub stairs: Option<Stairs>,
}
impl Default for SelectionShape {
    fn default() -> Self {
        Self {
            shape: Shape::Box,
            cylinder_axis: 1,
            stairs: None,
        }
    }
}
impl SelectionShape {
    pub fn cells(self, a: IVec3, b: IVec3, limit: usize) -> Result<Vec<IVec3>> {
        let min = a.min(b);
        let max = a.max(b);
        let size = max.as_i64vec3() - min.as_i64vec3() + glam::I64Vec3::ONE;
        ensure!(self.cylinder_axis < 3, "Invalid cylinder axis");
        if self.shape == Shape::Line {
            ensure!(
                size.max_element() <= limit as i64,
                "Selection exceeds {limit} cells"
            );
            return Ok(line(a, b));
        }
        ensure!(
            size.to_array()
                .into_iter()
                .try_fold(1_i64, |n, v| n.checked_mul(v))
                .is_some_and(|n| n <= limit as i64),
            "Selection exceeds {limit} cells"
        );
        let mut cells = Vec::new();
        let center = (min.as_dvec3() + max.as_dvec3() + glam::DVec3::ONE) * 0.5;
        let radii = size
            .as_dvec3()
            .map(|n| if n == 1.0 { 0.51 } else { (n - 0.5) * 0.5 });
        let stairs = self.stairs.unwrap_or_else(|| {
            let delta = b - a;
            let run = if delta.x.abs() >= delta.z.abs() { 0 } else { 2 };
            Stairs {
                run,
                rise: 1,
                run_direction: if delta[run] >= 0 { 1 } else { -1 },
                rise_direction: if delta.y >= 0 { 1 } else { -1 },
            }
        });
        ensure!(
            stairs.run < 3
                && stairs.rise < 3
                && stairs.run != stairs.rise
                && [stairs.run_direction, stairs.rise_direction]
                    .into_iter()
                    .all(|v| v == 1 || v == -1),
            "Invalid stairs orientation"
        );
        for x in min.x..=max.x {
            for y in min.y..=max.y {
                for z in min.z..=max.z {
                    let p = IVec3::new(x, y, z);
                    let unit = (p.as_dvec3() + glam::DVec3::splat(0.5) - center) / radii;
                    let inside = match self.shape {
                        Shape::Box => true,
                        Shape::Cylinder => {
                            (0..3)
                                .filter(|&axis| axis != self.cylinder_axis)
                                .map(|axis| unit[axis].powi(2))
                                .sum::<f64>()
                                <= 1.0 + 1e-5
                        }
                        Shape::Sphere => unit.length_squared() <= 1.0 + 1e-5,
                        Shape::Stairs => {
                            let run = if stairs.run_direction > 0 {
                                p[stairs.run] - min[stairs.run]
                            } else {
                                max[stairs.run] - p[stairs.run]
                            };
                            let rise = if stairs.rise_direction > 0 {
                                p[stairs.rise] - min[stairs.rise]
                            } else {
                                max[stairs.rise] - p[stairs.rise]
                            };
                            let height = if size[stairs.run] == 1 {
                                size[stairs.rise]
                            } else {
                                1 + ((run as f64 / (size[stairs.run] - 1) as f64)
                                    * (size[stairs.rise] - 1) as f64)
                                    .floor() as i64
                            };
                            (rise as i64) < height
                        }
                        Shape::Line => unreachable!(),
                    };
                    if inside {
                        cells.push(p);
                    }
                }
            }
        }
        Ok(cells)
    }
}
/// Inclusive Bresenham line with Web's tie-breaking order on all three axes.
pub fn line(a: IVec3, b: IVec3) -> Vec<IVec3> {
    let delta = (b - a).abs();
    let step = IVec3::new(
        if b.x >= a.x { 1 } else { -1 },
        if b.y >= a.y { 1 } else { -1 },
        if b.z >= a.z { 1 } else { -1 },
    );
    let axes = if delta.x >= delta.y && delta.x >= delta.z {
        [0, 1, 2]
    } else if delta.y >= delta.x && delta.y >= delta.z {
        [1, 0, 2]
    } else {
        [2, 1, 0]
    };
    let [major, u, v] = axes;
    let mut p = a;
    let mut error_u = 2 * delta[u] - delta[major];
    let mut error_v = 2 * delta[v] - delta[major];
    let mut out = Vec::with_capacity(delta[major] as usize + 1);
    while p[major] != b[major] {
        out.push(p);
        if error_u >= 0 {
            p[u] += step[u];
            error_u -= 2 * delta[major];
        }
        if error_v >= 0 {
            p[v] += step[v];
            error_v -= 2 * delta[major];
        }
        error_u += 2 * delta[u];
        error_v += 2 * delta[v];
        p[major] += step[major];
    }
    out.push(b);
    out
}

impl SelectionShape {
    /// Cylinders and stairs rotate inside fixed bounds; other shapes rotate the bounds.
    pub fn rotate(&mut self, a: IVec3, b: IVec3, axis: usize, direction: i32) -> (IVec3, IVec3) {
        let q = crate::resource_transform::quarter(axis, direction);
        let rotate = |p: IVec3| (q * p.as_dvec3()).round().as_ivec3();
        let oriented = |axis: usize, sign: i32| {
            let mut p = IVec3::ZERO;
            p[axis] = sign;
            let v = rotate(p);
            let next = (0..3).find(|&i| v[i] != 0).unwrap();
            (next, v[next])
        };
        if self.shape == Shape::Cylinder {
            self.cylinder_axis = oriented(self.cylinder_axis, 1).0;
            return (a, b);
        }
        if self.shape == Shape::Stairs {
            let delta = b - a;
            let run = if delta.x.abs() >= delta.z.abs() { 0 } else { 2 };
            let stairs = self.stairs.unwrap_or(Stairs {
                run,
                rise: 1,
                run_direction: if delta[run] >= 0 { 1 } else { -1 },
                rise_direction: if delta.y >= 0 { 1 } else { -1 },
            });
            let run = oriented(stairs.run, stairs.run_direction);
            let rise = oriented(stairs.rise, stairs.rise_direction);
            self.stairs = Some(Stairs {
                run: run.0,
                rise: rise.0,
                run_direction: run.1,
                rise_direction: rise.1,
            });
            return (a, b);
        }
        let min = a.min(b);
        let max = a.max(b);
        let center = (min.as_dvec3() + max.as_dvec3()) * 0.5;
        let extent = rotate(max - min).abs();
        let next_min = (center - extent.as_dvec3() * 0.5 + glam::DVec3::splat(0.5))
            .floor()
            .as_ivec3();
        let next_max = next_min + extent;
        let direction = rotate(b - a);
        let mut first = next_min;
        let mut last = next_max;
        for i in 0..3 {
            if direction[i] < 0 {
                first[i] = next_max[i];
                last[i] = next_min[i];
            }
        }
        (first, last)
    }
}
