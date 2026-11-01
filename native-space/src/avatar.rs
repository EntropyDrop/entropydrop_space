//! Bundled offline skin. Pixel-colored faces need no network or texture shader.
use crate::geometry::Face;
use anyhow::{Result, ensure};
use glam::{Mat4, Quat, Vec3};
use std::io::Cursor;

pub struct AvatarPart {
    pub faces: Vec<Face>,
    pub pivot: Vec3,
}
pub struct Avatar {
    pub parts: Vec<AvatarPart>,
}
impl Avatar {
    pub fn bundled() -> Result<Self> {
        let mut decoder =
            png::Decoder::new(Cursor::new(include_bytes!("../assets/default-skin.png")));
        decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        let mut reader = decoder.read_info()?;
        let mut data = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut data)?;
        ensure!(
            info.width == 64 && info.height == 64,
            "Default skin must be 64x64"
        );
        let channels = if info.color_type == png::ColorType::Rgba {
            4
        } else {
            3
        };
        ensure!(
            matches!(info.color_type, png::ColorType::Rgba | png::ColorType::Rgb),
            "Default skin must be RGB(A)"
        );
        // Per-face UVs: -X, +X, -Y, +Y, -Z, +Z; copied from CuteCharacter.
        let head = [
            [0, 8, 8, 8],
            [16, 8, 8, 8],
            [16, 0, 8, 8],
            [8, 0, 8, 8],
            [24, 8, 8, 8],
            [8, 8, 8, 8],
        ];
        let body = [
            [16, 20, 4, 12],
            [28, 20, 4, 12],
            [28, 16, 8, 4],
            [20, 16, 8, 4],
            [32, 20, 8, 12],
            [20, 20, 8, 12],
        ];
        let arm = [
            [40, 20, 4, 12],
            [48, 20, 4, 12],
            [48, 16, 4, 4],
            [44, 16, 4, 4],
            [52, 20, 4, 12],
            [44, 20, 4, 12],
        ];
        let leg = [
            [0, 20, 4, 12],
            [8, 20, 4, 12],
            [8, 16, 4, 4],
            [4, 16, 4, 4],
            [12, 20, 4, 12],
            [4, 20, 4, 12],
        ];
        let shift = |mut uv: [[i32; 4]; 6], x, y| {
            for f in &mut uv {
                f[0] += x;
                f[1] += y;
            }
            uv
        };
        let specs = [
            (
                Vec3::new(8.0, 8.0, 8.0),
                Vec3::new(0.0, 24.0, 0.0),
                Vec3::new(-4.0, 0.0, -4.0),
                head,
                shift(head, 32, 0),
            ),
            (
                Vec3::new(8.0, 12.0, 4.0),
                Vec3::new(0.0, 24.0, 0.0),
                Vec3::new(-4.0, -12.0, -2.0),
                body,
                shift(body, 0, 16),
            ),
            (
                Vec3::new(4.0, 12.0, 4.0),
                Vec3::new(-6.0, 24.0, 0.0),
                Vec3::new(-2.0, -12.0, -2.0),
                arm,
                shift(arm, 0, 16),
            ),
            (
                Vec3::new(4.0, 12.0, 4.0),
                Vec3::new(6.0, 24.0, 0.0),
                Vec3::new(-2.0, -12.0, -2.0),
                shift(arm, -8, 32),
                shift(arm, 8, 32),
            ),
            (
                Vec3::new(4.0, 12.0, 4.0),
                Vec3::new(-2.0, 12.0, 0.0),
                Vec3::new(-2.0, -12.0, -2.0),
                leg,
                shift(leg, 0, 16),
            ),
            (
                Vec3::new(4.0, 12.0, 4.0),
                Vec3::new(2.0, 12.0, 0.0),
                Vec3::new(-2.0, -12.0, -2.0),
                shift(leg, 16, 32),
                shift(leg, 0, 32),
            ),
        ];
        let scale = 1.8 / 32.0;
        let mut parts = Vec::new();
        for (size, pivot, offset, base, overlay) in specs {
            let mut faces = Vec::new();
            for (uv, expand) in [(base, 0.0), (overlay, 0.18)] {
                let dimensions = (size + Vec3::splat(expand * 2.0)) * scale;
                let offset = (offset - Vec3::splat(expand)) * scale;
                for (axis, [x, y, w, h]) in uv.into_iter().enumerate() {
                    let d = axis / 2;
                    let u = (d + 1) % 3;
                    let v = (d + 2) % 3;
                    for row in 0..h {
                        for col in 0..w {
                            let at = ((y + row) * 64 + x + col) as usize * channels;
                            if channels == 4 && data[at + 3] < 128 {
                                continue;
                            }
                            let color = 0x01000000
                                | (data[at] as u32) << 16
                                | (data[at + 1] as u32) << 8
                                | data[at + 2] as u32;
                            let mut origin = offset;
                            origin[d] += if axis % 2 == 1 { dimensions[d] } else { 0.0 };
                            let (cu, cv, wu, hv) = match d {
                                0 => (h - 1 - row, if axis == 0 { col } else { w - 1 - col }, h, w),
                                1 => (row, col, h, w),
                                _ => (if axis == 4 { w - 1 - col } else { col }, h - 1 - row, w, h),
                            };
                            let extent = [dimensions[u] / wu as f32, dimensions[v] / hv as f32];
                            origin[u] += cu as f32 * extent[0];
                            origin[v] += cv as f32 * extent[1];
                            faces.push(Face {
                                origin: origin.to_array(),
                                extent,
                                axis: axis as u32,
                                color,
                                // Preserve the analytic face normal: derivatives of
                                // kilometre-scale world positions lose precision
                                // when the first-person arm fills the viewport.
                                padding: 4,
                            });
                        }
                    }
                }
            }
            parts.push(AvatarPart {
                faces,
                pivot: pivot * scale,
            });
        }
        Ok(Self { parts })
    }
    pub fn models(
        &self,
        feet: Vec3,
        yaw: f32,
        pitch: f32,
        phase: f32,
        moving: bool,
        seated: bool,
    ) -> Vec<Mat4> {
        let base = Mat4::from_rotation_translation(
            Quat::from_rotation_y(std::f32::consts::PI - yaw),
            feet,
        );
        self.parts
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let swing = if moving { phase.sin() * 0.5 } else { 0.0 };
                let angle = match i {
                    0 => -pitch,
                    2 | 5 => swing,
                    3 | 4 => -swing,
                    _ => 0.0,
                };
                let angle = if seated && i >= 4 { -1.35 } else { angle };
                base * Mat4::from_rotation_translation(Quat::from_rotation_x(angle), p.pivot)
            })
            .collect()
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn bundled_skin_is_complete_and_finite() {
        let avatar = super::Avatar::bundled().unwrap();
        assert_eq!(avatar.parts.len(), 6);
        for p in avatar.parts {
            assert!(!p.faces.is_empty());
            for f in p.faces {
                assert!(
                    f.origin
                        .iter()
                        .chain(f.extent.iter())
                        .all(|v| v.is_finite())
                );
                assert!(f.extent.iter().all(|v| *v > 0.0));
                assert_eq!(f.color >> 24, 1);
                assert_eq!(f.padding, 4);
            }
        }
    }
}
