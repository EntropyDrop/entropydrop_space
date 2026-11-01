use bytemuck::{Pod, Zeroable};
use glam::{DMat3, DVec3, Mat4, Vec3};

pub const WORLD_X: i32 = 16384;
pub const WORLD_Z: i32 = 2048;
pub const MAJOR_RADIUS: f64 = WORLD_X as f64 / std::f64::consts::TAU;
pub const MINOR_RADIUS: f64 = WORLD_Z as f64 / std::f64::consts::TAU;

pub fn wrap_near(value: f64, anchor: f64, period: f64) -> f64 {
    let delta = (value - anchor + period * 0.5).rem_euclid(period) - period * 0.5;
    anchor + delta
}
pub fn bend(p: DVec3) -> DVec3 {
    let theta = p.x * std::f64::consts::TAU / WORLD_X as f64;
    let t = p.z * std::f64::consts::TAU / WORLD_Z as f64;
    let phi = 2.0 * (((9.0_f64 / 7.0).sqrt()) * (t * 0.5).sin()).atan2((t * 0.5).cos());
    let scale = 1.0 + MINOR_RADIUS * phi.cos() / MAJOR_RADIUS;
    let rho = (MINOR_RADIUS + (p.y - 16.0) * scale).min(MAJOR_RADIUS - 1.0);
    DVec3::new(
        (MAJOR_RADIUS + rho * phi.cos()) * theta.cos(),
        rho * phi.sin(),
        (MAJOR_RADIUS + rho * phi.cos()) * theta.sin(),
    )
}
pub fn frame(p: DVec3) -> DMat3 {
    let theta = p.x * std::f64::consts::TAU / WORLD_X as f64;
    let t = p.z * std::f64::consts::TAU / WORLD_Z as f64;
    let phi = 2.0 * ((9.0_f64 / 7.0).sqrt() * (t * 0.5).sin()).atan2((t * 0.5).cos());
    DMat3::from_cols(
        DVec3::new(-theta.sin(), 0.0, theta.cos()),
        DVec3::new(phi.cos() * theta.cos(), phi.sin(), phi.cos() * theta.sin()),
        DVec3::new(
            -phi.sin() * theta.cos(),
            phi.cos(),
            -phi.sin() * theta.sin(),
        ),
    )
}

/// Web TorusWorld.setTorusViewCorrection: orthonormal frame * inverse Jacobian.
/// Compute in f64: a 0.01 m derivative loses precision at torus-scale f32 positions.
pub fn view_correction(camera: DVec3) -> DMat3 {
    let origin = bend(camera);
    let derivative = DMat3::from_cols(
        (bend(camera + DVec3::X * 0.01) - origin) / 0.01,
        (bend(camera + DVec3::Y * 0.01) - origin) / 0.01,
        (bend(camera + DVec3::Z * 0.01) - origin) / 0.01,
    );
    frame(camera) * derivative.inverse()
}
pub fn bend_for_view(point: DVec3, camera: DVec3) -> DVec3 {
    let bent = bend(point);
    let delta = bent - bend(camera);
    let t = ((delta.length() - 96.0) / 160.0).clamp(0.0, 1.0);
    bent + (view_correction(camera) * delta - delta) * (1.0 - t * t * (3.0 - 2.0 * t))
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct Face {
    pub origin: [f32; 3],
    pub color: u32,
    pub extent: [f32; 2],
    pub axis: u32,
    pub padding: u32,
}

/// Lossless 1/8 m local coordinates; colour/material bits remain unchanged.
/// xy, z/width, height/axis/flags, colour. Shared with distant.ts and Metal.
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct PackedFace {
    pub words: [u32; 4],
}
impl PackedFace {
    pub fn pack(face: Face, origin: Vec3) -> Option<Self> {
        let p = Vec3::from_array(face.origin) - origin;
        let values = [p.x, p.y, p.z, face.extent[0], face.extent[1]];
        let mut q = [0_u32; 5];
        for (i, v) in values.into_iter().enumerate() {
            let scaled = v * 8.0;
            if !scaled.is_finite() || scaled.fract() != 0.0 || !(0.0..=65535.0).contains(&scaled) {
                return None;
            }
            q[i] = scaled as u32;
        }
        if face.axis > 5 || face.padding > 8191 {
            return None;
        }
        let packed = Self {
            words: [
                q[0] | q[1] << 16,
                q[2] | q[3] << 16,
                q[4] | face.axis << 16 | face.padding << 19,
                face.color,
            ],
        };
        let decoded = packed.unpack(origin);
        if decoded.origin != face.origin || decoded.extent != face.extent {
            return None;
        }
        Some(packed)
    }
    pub fn unpack(self, origin: Vec3) -> Face {
        let [a, b, c, color] = self.words;
        Face {
            origin: (origin
                + Vec3::new((a & 65535) as f32, (a >> 16) as f32, (b & 65535) as f32) * 0.125)
                .to_array(),
            extent: [(b >> 16) as f32 * 0.125, (c & 65535) as f32 * 0.125],
            axis: (c >> 16) & 7,
            padding: c >> 19,
            color,
        }
    }
}

/// Greedy mesh all six sides. The sampler supplies a one-cell neighbor halo.
pub fn greedy_mesh(
    size: [usize; 3],
    origin: Vec3,
    scale: f32,
    sample: impl Fn(i32, i32, i32) -> u32,
) -> Vec<Face> {
    let mut faces = Vec::new();
    for d in 0..3 {
        let u = (d + 1) % 3;
        let v = (d + 2) % 3;
        let mut mask = vec![0_u32; size[u] * size[v]];
        for side in 0..2 {
            for slice in 0..size[d] {
                for j in 0..size[v] {
                    for i in 0..size[u] {
                        let mut p = [0_i32; 3];
                        p[d] = slice as i32;
                        p[u] = i as i32;
                        p[v] = j as i32;
                        let a = sample(p[0], p[1], p[2]);
                        p[d] += if side == 1 { 1 } else { -1 };
                        let b = sample(p[0], p[1], p[2]);
                        // Preserve interfaces between transparent and opaque cells.
                        mask[i + j * size[u]] = if a != 0 && (b == 0 || ((b >> 24) > 2 && a != b)) {
                            a
                        } else {
                            0
                        };
                    }
                }
                let mut j = 0;
                while j < size[v] {
                    let mut i = 0;
                    while i < size[u] {
                        let color = mask[i + j * size[u]];
                        if color == 0 {
                            i += 1;
                            continue;
                        }
                        let mut w = 1;
                        while i + w < size[u] && mask[i + w + j * size[u]] == color {
                            w += 1;
                        }
                        let mut h = 1;
                        'height: while j + h < size[v] {
                            for k in 0..w {
                                if mask[i + k + (j + h) * size[u]] != color {
                                    break 'height;
                                }
                            }
                            h += 1;
                        }
                        let mut p = [0_f32; 3];
                        p[d] = (slice + side) as f32;
                        p[u] = i as f32;
                        p[v] = j as f32;
                        faces.push(Face {
                            origin: (origin + Vec3::from_array(p) * scale).to_array(),
                            color,
                            extent: [w as f32 * scale, h as f32 * scale],
                            axis: (d * 2 + side) as u32,
                            padding: 0,
                        });
                        for y in j..j + h {
                            for x in i..i + w {
                                mask[x + y * size[u]] = 0;
                            }
                        }
                        i += w;
                    }
                    j += 1;
                }
            }
        }
    }
    faces
}

pub fn aabb_hit(origin: DVec3, dir: DVec3, min: DVec3, max: DVec3) -> Option<(f64, DVec3)> {
    let mut near = 0.0_f64;
    let mut far = f64::INFINITY;
    let mut normal = DVec3::ZERO;
    for d in 0..3 {
        if dir[d].abs() < 1e-12 {
            if origin[d] < min[d] || origin[d] > max[d] {
                return None;
            }
            continue;
        }
        let a = (min[d] - origin[d]) / dir[d];
        let b = (max[d] - origin[d]) / dir[d];
        if a.min(b) > near {
            near = a.min(b);
            normal = DVec3::ZERO;
            normal[d] = -dir[d].signum();
        }
        far = far.min(a.max(b));
        if far < near {
            return None;
        }
    }
    Some((near, normal))
}

pub fn camera_matrix(position: DVec3, direction: DVec3, aspect: f32, torus: bool) -> Mat4 {
    let (eye, forward, up) = if torus {
        (
            bend(position),
            frame(position) * direction,
            frame(position) * DVec3::Y,
        )
    } else {
        (position, direction, DVec3::Y)
    };
    Mat4::perspective_rh(70_f32.to_radians(), aspect.max(0.01), 0.1, 10000.0)
        * Mat4::look_to_rh(eye.as_vec3(), forward.as_vec3(), up.as_vec3())
}

/// Metal's clip volume has z in [0,w]; leave spheres intersecting a plane visible.
pub fn sphere_in_frustum(clip: Mat4, center: Vec3, radius: f32) -> bool {
    let r0 = clip.row(0);
    let r1 = clip.row(1);
    let r2 = clip.row(2);
    let r3 = clip.row(3);
    [r3 + r0, r3 - r0, r3 + r1, r3 - r1, r2, r3 - r2]
        .iter()
        .all(|p| p.truncate().dot(center) + p.w >= -radius * p.truncate().length())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compact_faces_preserve_micro_coordinates_and_all_material_bits() {
        assert_eq!(std::mem::size_of::<PackedFace>(), 16);
        let anchor = Vec3::new(-512.0, -128.0, 15872.0);
        for axis in 0..6 {
            for material in 1..=102 {
                for flags in 0..4 {
                    let f = Face {
                        origin: (anchor + Vec3::new(0.125, 8191.875, 511.875)).to_array(),
                        color: material << 24 | 0xabcdef,
                        extent: [0.125, 8191.875],
                        axis,
                        padding: flags,
                    };
                    let g = PackedFace::pack(f, anchor).unwrap().unpack(anchor);
                    assert_eq!(bytemuck::bytes_of(&f), bytemuck::bytes_of(&g));
                }
            }
        }
        let f = Face {
            origin: [0.01, 0.0, 0.0],
            color: 0x01ffffff,
            extent: [1.0, 1.0],
            axis: 0,
            padding: 0,
        };
        assert!(PackedFace::pack(f, Vec3::ZERO).is_none());
    }
    #[test]
    fn cube_merges_into_six_quads() {
        let f = greedy_mesh([4, 4, 4], Vec3::ZERO, 1.0, |x, y, z| {
            if (0..4).contains(&x) && (0..4).contains(&y) && (0..4).contains(&z) {
                0x01ffffff
            } else {
                0
            }
        });
        assert_eq!(f.len(), 6);
        assert!(f.iter().all(|f| f.extent == [4.0, 4.0]));
    }
    #[test]
    fn adjacent_chunks_hide_boundary() {
        let f = greedy_mesh([2, 2, 2], Vec3::ZERO, 1.0, |x, y, z| {
            if (0..4).contains(&x) && (0..2).contains(&y) && (0..2).contains(&z) {
                0x01000000
            } else {
                0
            }
        });
        assert_eq!(f.len(), 5);
    }
    #[test]
    fn torus_seams_match() {
        let p = DVec3::new(0.0, 33.0, 100.0);
        assert!(bend(p).distance(bend(p + DVec3::X * WORLD_X as f64)) < 1e-8);
        assert!(bend(p).distance(bend(p + DVec3::Z * WORLD_Z as f64)) < 1e-8);
        assert!((frame(p).determinant() - 1.0).abs() < 1e-10);
    }
}
