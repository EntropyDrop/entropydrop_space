//! Sky stability and GPU resource regressions, outside timed samples.
use super::*;
use glam::Quat;

pub fn previous() -> RenderProbe {
    RenderProbe {
        inherit_cull_proofs: false,
        quad_group: 32,
        cache_submission: false,
        cache_shadows: false,
        reuse_buffers: false,
        memoryless_msaa: false,
        ..Default::default()
    }
}

impl Renderer {
    /// With fixed local heading and cloud time, an infinitely distant sky must
    /// not move when the camera translates, including across either torus seam.
    pub fn validate_sky(&mut self, output: &Path) -> Result<()> {
        anyhow::ensure!(
            self.meshes.is_empty() && self.replay.is_empty(),
            "Sky-only renderer required"
        );
        self.animate_sky = false;
        let size = [1280, 720];
        let direction = DVec3::new(0.3, 0.35, -1.0).normalize();
        let view = |position: DVec3, direction: DVec3, torus: bool| Uniforms {
            clip: geometry::camera_matrix(position, direction, 16.0 / 9.0, torus)
                .to_cols_array_2d(),
            model: Mat4::IDENTITY.to_cols_array_2d(),
            camera: position.as_vec3().extend(0.0).to_array(),
            options: [u8::from(torus) as f32, 1.0, 0.0, 1.0],
        };
        let target = self.offscreen_texture(size[0], size[1])?;
        let render = |renderer: &mut Self, u| -> Result<Vec<u8>> {
            let command = renderer.encode(&target, u, &[], 1.0)?;
            command.commit();
            renderer.inflight.push_back(command);
            renderer.finish()?;
            Ok(Self::read_pixels(&target))
        };
        let difference = |a: &[u8], b: &[u8]| {
            let mut sum = 0_u64;
            let mut max = 0_u8;
            let mut changed = 0;
            for (a, b) in a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0) {
                let mut pixel_max = 0;
                for channel in 0..3 {
                    let d = a[channel].abs_diff(b[channel]);
                    sum += u64::from(d);
                    max = max.max(d);
                    pixel_max = pixel_max.max(d);
                }
                changed += usize::from(pixel_max > 2);
            }
            (sum as f64 / (size[0] * size[1] * 3) as f64, max, changed)
        };
        let mut cases = Vec::new();
        let mut passed = true;
        for (name, torus, origin, step) in [
            (
                "flat",
                false,
                DVec3::new(8315.0, 108.0, 1098.0),
                DVec3::new(0.13, 0.07, -0.11),
            ),
            (
                "torus",
                true,
                DVec3::new(8315.0, 108.0, 1098.0),
                DVec3::new(0.13, 0.07, -0.11),
            ),
            (
                "torus-x-seam",
                true,
                DVec3::new(16383.8, 108.0, 1098.0),
                DVec3::X * 0.02,
            ),
            (
                "torus-z-seam",
                true,
                DVec3::new(8315.0, 108.0, 2047.8),
                DVec3::Z * 0.02,
            ),
        ] {
            let reference = render(self, view(origin, direction, torus))?;
            self.write_png(&target, &output.join(format!("sky-{name}-reference.png")))?;
            let mut previous = reference.clone();
            let mut frames = Vec::new();
            for i in 1..=32 {
                let mut position = origin + step * i as f64;
                if torus {
                    position.x = position.x.rem_euclid(geometry::WORLD_X as f64);
                    position.z = position.z.rem_euclid(geometry::WORLD_Z as f64);
                }
                let pixels = render(self, view(position, direction, torus))?;
                let (mean, max, changed) = difference(&reference, &pixels);
                let (temporal_mean, _, _) = difference(&previous, &pixels);
                // Allow subpixel floating-point/8-bit rounding, not cloud motion.
                passed &= mean < 0.01 && changed < size[0] * size[1] / 1000;
                frames.push(serde_json::json!({"frame":i,"mean_channel_error":mean,
                    "max_channel_error":max,"pixels_over_2":changed,"temporal_mean_error":temporal_mean}));
                previous = pixels;
            }
            self.write_png(&target, &output.join(format!("sky-{name}-translated.png")))?;
            // Guard against accidentally freezing the sky orientation as well.
            let rotated = render(
                self,
                view(origin, glam::DQuat::from_rotation_y(0.2) * direction, torus),
            )?;
            let (turn_mean, _, _) = difference(&reference, &rotated);
            passed &= turn_mean > 1.0;
            let worst = frames
                .iter()
                .map(|f| f["mean_channel_error"].as_f64().unwrap())
                .fold(0.0, f64::max);
            println!(
                "Sky {name}: worst translated RGB error {worst:.6}/255, turn {turn_mean:.3}/255"
            );
            cases
                .push(serde_json::json!({"case":name,"frames":frames,"turn_mean_error":turn_mean}));
        }
        let report = serde_json::json!({"passed":passed,"device":self.device.name().to_string(),
            "resolution":size,"quality":"Ultra / 4x MSAA / all post processing",
            "cloud_time":0,"translation_frames":128,"cases":cases,
            "limits":{"mean_rgb_error":0.01,"fraction_pixels_over_2":0.001,"turn_mean_error_min":1.0}});
        space_native::storage::atomic_write(
            &output.join("sky-validation.json"),
            &serde_json::to_vec_pretty(&report)?,
        )?;
        anyhow::ensure!(
            passed,
            "Sky changes during translation; see sky-validation.json"
        );
        Ok(())
    }

    /// Representative egui meshes/atlas, kept fixed during render-only timing.
    pub fn benchmark_ui(&mut self) -> Result<Vec<egui::ClippedPrimitive>> {
        let ctx = egui::Context::default();
        let out = ctx.run(
            egui::RawInput {
                screen_rect: Some(egui::Rect::from_min_size(
                    egui::Pos2::ZERO,
                    egui::vec2(1280.0, 720.0),
                )),
                ..Default::default()
            },
            |ctx| {
                egui::TopBottomPanel::top("top").show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        ui.heading("SPACE SOLO");
                        ui.label("Local world · Ultra");
                    });
                });
                egui::TopBottomPanel::bottom("tools").show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        for label in [
                            "Select", "Hammer", "Wrench", "Shovel", "Spoon", "Brush", "Model",
                        ] {
                            let _ = ui.button(label);
                        }
                    });
                });
                egui::SidePanel::left("properties").show(ctx, |ui| {
                    ui.heading("Properties");
                    for i in 0..24 {
                        ui.label(format!("Component {i} · local transform"));
                    }
                });
            },
        );
        self.update_textures(&out.textures_delta)?;
        Ok(ctx.tessellate(out.shapes, out.pixels_per_point))
    }

    pub fn validate_frame_resources(
        &mut self,
        u: Uniforms,
        paint: &[egui::ClippedPrimitive],
    ) -> Result<serde_json::Value> {
        self.finish()?;
        self.animate_sky = false;
        let saved_probe = self.probe;
        let eye = DVec3::new(u.camera[0] as f64, u.camera[1] as f64, u.camera[2] as f64);
        let direction = DVec3::new(-30.0, -50.0, -45.0).normalize();
        let view = |position: DVec3, yaw: f64, torus: bool| Uniforms {
            clip: geometry::camera_matrix(
                position,
                glam::DQuat::from_rotation_y(yaw) * direction,
                16.0 / 9.0,
                torus,
            )
            .to_cols_array_2d(),
            camera: position.as_vec3().extend(0.0).to_array(),
            options: [u8::from(torus) as f32, 1.0, 0.0, 1.0],
            ..u
        };
        // Different visibility and UI contents on every frame. Three outstanding
        // submissions, 36 frames: twelve complete wraps of the reusable ring.
        let mut frames = Vec::new();
        for i in 0..36 {
            let mut paint = paint.to_vec();
            for p in &mut paint {
                if let egui::epaint::Primitive::Mesh(mesh) = &mut p.primitive {
                    for v in &mut mesh.vertices {
                        v.pos.x += (i % 7) as f32;
                    }
                }
            }
            frames.push((
                view(eye + DVec3::X * (i / 3) as f64, i as f64 * 0.013, true),
                paint,
            ));
        }
        let size = [640, 360];
        let mut reference = Vec::new();
        self.probe = previous();
        for (u, paint) in &frames {
            let target = self.offscreen_texture(size[0], size[1])?;
            let command = self.encode(&target, *u, paint, 1.0)?;
            command.commit();
            self.inflight.push_back(command);
            self.finish()?;
            reference.push(Self::read_pixels(&target));
        }
        self.probe = RenderProbe::default();
        let mut targets = Vec::new();
        for (u, paint) in &frames {
            let target = self.offscreen_texture(size[0], size[1])?;
            let command = self.encode(&target, *u, paint, 1.0)?;
            command.commit();
            self.inflight.push_back(command);
            targets.push(target);
        }
        self.finish()?;
        for (i, (expected, target)) in reference.iter().zip(&targets).enumerate() {
            anyhow::ensure!(
                *expected == Self::read_pixels(target),
                "Queued frame {i} differs from allocated-buffer reference"
            );
        }

        let mut mask = vec![0_u8; 1024 * 128 * 2];
        unsafe {
            self.mask.getBytes_bytesPerRow_fromRegion_mipmapLevel(
                NonNull::new(mask.as_mut_ptr().cast()).unwrap(),
                2048,
                MTLRegion {
                    origin: MTLOrigin { x: 0, y: 0, z: 0 },
                    size: MTLSize {
                        width: 1024,
                        height: 128,
                        depth: 1,
                    },
                },
                0,
            );
        }
        let key = "validation-caster";
        let faces = geometry::greedy_mesh([2, 2, 2], Vec3::ZERO, 1.0, |x, y, z| {
            if (0..2).contains(&x) && (0..2).contains(&y) && (0..2).contains(&z) {
                0x01e0a040
            } else {
                0
            }
        });
        let model = Mat4::from_translation((eye + direction * 12.0).as_vec3());
        let mut current = view(eye, 0.0, true);
        let mut size = size;
        let mut checks = Vec::new();
        for (phase, (label, expected_hit)) in [
            ("new caster", false),
            ("unchanged scene", true),
            ("camera rotation", true),
            ("camera translation", false),
            ("entity pose", false),
            ("replace geometry", false),
            ("delete caster", false),
            ("transparent object", true),
            ("placement preview", true),
            ("near/far coverage", false),
            ("flat projection", false),
            ("restore projection and mask", false),
            ("viewport resize", true),
            ("insert retained caster", false),
            ("unchanged entity pose", true),
            ("bulk caster removal", false),
            ("preview removal", true),
            ("first-person hand", true),
            ("hand removal", true),
            ("distant tile replacement", false),
        ]
        .into_iter()
        .enumerate()
        {
            match phase {
                0 => self.upload(key.into(), &faces, model)?,
                2 => current = view(eye, 0.3, true),
                3 => current = view(eye + DVec3::X, 0.3, true),
                4 => self.set_model(key, model * Mat4::from_quat(Quat::from_rotation_y(0.8))),
                5 => self.upload(key.into(), &faces[..3], model)?,
                6 => self.remove(key),
                7 => {
                    let mut alpha = faces.clone();
                    for f in &mut alpha {
                        f.color = 0x33e0a040;
                    }
                    self.upload(key.into(), &alpha, model)?;
                }
                8 => self.upload("preview:validation".into(), &faces, model)?,
                9 => self.upload_mask(&vec![0; mask.len()])?,
                10 => current = view(eye + DVec3::X, 0.3, false),
                11 => {
                    current = view(eye + DVec3::X, 0.3, true);
                    self.upload_mask(&mask)?;
                }
                12 => size = [800, 450],
                13 => self.upload(key.into(), &faces, model)?,
                14 => self.set_model(key, model),
                15 => self.retain_meshes(|name| name != key && name != "validation-caster:alpha"),
                16 => self.retain_meshes(|name| name != "preview:validation"),
                17 => self.upload("avatar:hand:validation".into(), &faces, model)?,
                18 => self.retain_meshes(|name| name != "avatar:hand:validation"),
                19 => {
                    let (key, mesh) = self
                        .meshes
                        .iter()
                        .find(|(k, m)| k.starts_with("far:") && m.packed)
                        .context("Need distant geometry for cache regression")?;
                    let data = unsafe {
                        std::slice::from_raw_parts(
                            mesh.buffer.contents().as_ptr().cast::<PackedFace>(),
                            mesh.faces,
                        )
                        .to_vec()
                    };
                    let (bounds, torus) = mesh.bounds.unwrap();
                    let tile = space_native::distant::Tile {
                        key: key.clone(),
                        file: String::new(),
                        bounds,
                        faces: mesh.faces,
                        format: 2,
                        origin: mesh.origin.to_array(),
                        data,
                        visibility: mesh.blocks.clone(),
                    };
                    self.upload_distant(&tile, torus)?;
                }
                _ => {}
            }
            self.probe = RenderProbe::default();
            let target = self.offscreen_texture(size[0], size[1])?;
            let command = self.encode(&target, current, paint, 1.0)?;
            anyhow::ensure!(
                self.shadow_cache_hit == expected_hit,
                "Unexpected shadow reuse for {label}"
            );
            command.commit();
            self.inflight.push_back(command);
            self.finish()?;
            let cached = Self::read_pixels(&target);
            self.probe = previous();
            let command = self.encode(&target, current, paint, 1.0)?;
            command.commit();
            self.inflight.push_back(command);
            self.finish()?;
            anyhow::ensure!(
                cached == Self::read_pixels(&target),
                "Cached output differs after {label}"
            );
            checks.push(
                serde_json::json!({"case":label,"cache_hit":expected_hit,"different_pixels":0}),
            );
            // Prime the real cache for the next mutation. No fabricated cache keys.
            self.probe = RenderProbe::default();
            let command = self.encode(&target, current, paint, 1.0)?;
            command.commit();
            self.inflight.push_back(command);
            self.finish()?;
        }
        self.remove(key);
        self.remove("preview:validation");
        self.upload_mask(&mask)?;
        self.probe = saved_probe;
        Ok(
            serde_json::json!({"queued_frames":frames.len(),"max_inflight":3,"queued_different_pixels":0,"shadow_cases":checks}),
        )
    }
}

#[cfg(test)]
mod sky_tests {
    use super::*;

    #[test]
    fn sky_rays_match_camera_heading_at_large_positions_and_torus_seams() {
        for torus in [false, true] {
            for size in [[1280, 720], [1908, 2018]] {
                for position in [
                    DVec3::ZERO,
                    DVec3::new(8315.123, 108.073, 1097.912),
                    DVec3::new(16383.999, 250.0, 2047.999),
                    DVec3::new(0.001, 250.0, 0.001),
                ] {
                    for heading in [DVec3::NEG_Z, DVec3::new(0.3, 0.35, -1.0).normalize()] {
                        let aspect = size[0] as f32 / size[1] as f32;
                        let u = Uniforms {
                            clip: geometry::camera_matrix(position, heading, aspect, torus)
                                .to_cols_array_2d(),
                            camera: position.as_vec3().extend(0.0).to_array(),
                            model: Mat4::IDENTITY.to_cols_array_2d(),
                            options: [u8::from(torus) as f32, 1.0, 0.0, 1.0],
                        };
                        let f = FrameUniforms::new(u, size[0], size[1], 0.0);
                        let inverse = Mat4::from_cols_array_2d(&f.inverse_direction_clip);
                        let basis = if torus {
                            geometry::frame(position)
                        } else {
                            glam::DMat3::IDENTITY
                        };
                        let right = heading.cross(DVec3::Y).normalize();
                        let up = right.cross(heading);
                        for x in [-0.9, 0.0, 0.9] {
                            for y in [-0.9, 0.0, 0.9] {
                                let actual = (inverse * glam::Vec4::new(x, y, 1.0, 1.0))
                                    .truncate()
                                    .normalize()
                                    .as_dvec3();
                                let tangent = 35_f64.to_radians().tan();
                                let expected = basis
                                    * (heading
                                        + right * (x as f64 * tangent * aspect as f64)
                                        + up * (y as f64 * tangent))
                                        .normalize();
                                assert!(
                                    (actual - expected).length() < 2e-6,
                                    "Sky ray mismatch at {position:?}, torus={torus}, ndc=({x},{y})"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}
