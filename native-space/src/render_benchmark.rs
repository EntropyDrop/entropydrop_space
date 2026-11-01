//! Frozen production geometry replay: an honest matched workload, not live LOD.
use crate::metal_renderer::{Renderer, Uniforms};
use anyhow::{Context, Result, ensure};
use glam::{DVec3, Mat4, Quat, Vec3};
use objc2_metal::MTLDevice;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use space_native::storage::atomic_write;
use std::path::Path;

/// Sweep only instance size: same face order, shaders, culling and Ultra.
pub fn groups(
    renderer: &mut Renderer,
    u: Uniforms,
    root: &Path,
    world: &str,
    lod: serde_json::Value,
) -> Result<()> {
    use crate::metal_renderer::RenderProbe;
    let mut cases = Vec::new();
    for size in [[1280, 720], [2560, 1440]] {
        for round in 0..2 {
            let mut groups = vec![8, 16, 32, 64, 128, 256];
            if round == 1 {
                groups.reverse();
            }
            for group in groups {
                renderer.probe = RenderProbe {
                    quad_group: group,
                    cache_submission: false,
                    ..Default::default()
                };
                let (gpu, wall) = renderer.benchmark(u, size, 24, 120)?;
                println!(
                    "Groups {size:?} round {round} size {group}: GPU {:.3}, serial {:.3}",
                    summary(&gpu)["p50"].as_f64().unwrap(),
                    summary(&wall)["p50"].as_f64().unwrap()
                );
                cases.push(serde_json::json!({"resolution":size,"round":round,"group":group,"gpu_ms":summary(&gpu),"serial_ms":summary(&wall),"raw_gpu_ms":gpu,"raw_serial_ms":wall,"faces":renderer.visible_faces}));
                if round == 1 {
                    renderer.draw_offscreen(
                        u,
                        size,
                        &root.join(format!(
                            "results/groups-{world}-{group}-{}x{}.png",
                            size[0], size[1]
                        )),
                    )?;
                }
            }
        }
    }
    atomic_write(
        &root.join(format!("results/{world}-groups-profile.json")),
        &serde_json::to_vec_pretty(
            &serde_json::json!({"device":renderer.device.name().to_string(),"lod":lod,"resident_faces":renderer.resident_faces(),"quality":"Ultra 100%, 4x MSAA, 4096 shadows, unchanged frozen LOD","cases":cases}),
        )?,
    )?;
    Ok(())
}

pub fn optimized(
    renderer: &mut Renderer,
    uniforms: Uniforms,
    root: &Path,
    world: &str,
    lod: serde_json::Value,
    mode: u8,
) -> Result<()> {
    use crate::metal_renderer::RenderProbe;
    use space_native::geometry;
    let culling_only = mode == 3;
    let frame_reuse = mode == 4;
    let submission = mode == 5;
    let recent = frame_reuse || submission;
    let prefix = if submission {
        "submission"
    } else if frame_reuse {
        "frame-reuse"
    } else if culling_only {
        "culling"
    } else {
        "optimized"
    };
    let legacy = if submission {
        RenderProbe {
            inherit_cull_proofs: false,
            quad_group: 32,
            cache_submission: false,
            ..Default::default()
        }
    } else if frame_reuse {
        RenderProbe {
            cache_shadows: false,
            reuse_buffers: false,
            memoryless_msaa: false,
            ..Default::default()
        }
    } else if culling_only {
        RenderProbe {
            hierarchical_culling: false,
            ..Default::default()
        }
    } else {
        RenderProbe::legacy()
    };
    let variants = [
        ("legacy", legacy),
        (
            "grouped",
            RenderProbe {
                grouped_quads: true,
                ..legacy
            },
        ),
        (
            "compact",
            RenderProbe {
                grouped_quads: true,
                compact_faces: true,
                ..legacy
            },
        ),
        ("optimized", RenderProbe::default()),
    ];
    let variants = if submission {
        vec![("previous", legacy), ("optimized", RenderProbe::default())]
    } else if frame_reuse {
        vec![
            ("previous", legacy),
            (
                "buffers",
                RenderProbe {
                    reuse_buffers: true,
                    ..legacy
                },
            ),
            (
                "shadows",
                RenderProbe {
                    cache_shadows: true,
                    ..legacy
                },
            ),
            ("optimized", RenderProbe::default()),
        ]
    } else if culling_only {
        vec![("linear", legacy), ("hierarchy", RenderProbe::default())]
    } else {
        variants.to_vec()
    };
    let rounds = if recent { 4 } else { 2 };
    let mut cases = Vec::new();
    for size in [[1280, 720], [2560, 1440]] {
        for round in 0..rounds {
            let order: Vec<_> = if round % 2 == 0 {
                variants.iter().collect()
            } else {
                variants.iter().rev().collect()
            };
            for &(name, probe) in order {
                renderer.probe = probe;
                let (gpu, wall) = renderer.benchmark(uniforms, size, 24, 120)?;
                let row = serde_json::json!({"mode":name,"round":round,"resolution":size,"gpu_ms":summary(&gpu),"serial_frame_ms":summary(&wall),
                    "raw_gpu_ms":gpu,"raw_serial_frame_ms":wall,"submitted_faces":renderer.visible_faces,"shadow_faces":renderer.shadow_faces,"scene_draws":renderer.draw_calls,"shadow_draws":renderer.shadow_draws,"dynamic_allocations":renderer.benchmark_allocations,"shadow_cache_hits":renderer.benchmark_shadow_hits,"msaa_attachment_bytes":renderer.msaa_attachment_bytes()});
                println!(
                    "Optimize {size:?} {round} {name}: GPU {:.3}, serial {:.3}, faces {}/{}",
                    row["gpu_ms"]["p50"].as_f64().unwrap(),
                    row["serial_frame_ms"]["p50"].as_f64().unwrap(),
                    renderer.visible_faces,
                    renderer.shadow_faces
                );
                cases.push(row);
            }
        }
    }
    let eye = DVec3::new(
        uniforms.camera[0] as f64,
        uniforms.camera[1] as f64,
        uniforms.camera[2] as f64,
    );
    let direction = DVec3::new(-30.0, -50.0, -45.0).normalize();
    let make = |eye: DVec3, direction: DVec3| Uniforms {
        clip: geometry::camera_matrix(eye, direction, 16.0 / 9.0, true).to_cols_array_2d(),
        camera: eye.as_vec3().extend(0.0).to_array(),
        ..uniforms
    };
    let views = [
        ("overview", uniforms),
        (
            "turn",
            make(eye, glam::DQuat::from_rotation_y(1.2) * direction),
        ),
        (
            "close",
            make(
                eye + DVec3::new(-30.0, -35.0, -45.0),
                DVec3::new(1.0, -0.2, 0.4).normalize(),
            ),
        ),
        ("transition", make(eye - DVec3::X * 180.0, direction)),
        (
            "seam",
            make(
                DVec3::new(16383.875, 205.0, 2047.875),
                DVec3::new(-1.0, -0.3, -0.4).normalize(),
            ),
        ),
    ];
    let mut images = Vec::new();
    for (view, u) in views {
        for size in [[1280, 720], [2560, 1440]] {
            if view != "overview" && size[0] > 1280 {
                continue;
            }
            for (mode, options) in [("legacy", legacy), ("optimized", RenderProbe::default())] {
                renderer.probe = RenderProbe {
                    validate_visibility: culling_only,
                    ..options
                };
                let path = root.join(format!(
                    "results/{prefix}-{world}-{view}-{mode}-{}x{}.png",
                    size[0], size[1]
                ));
                renderer.draw_offscreen(u, size, &path)?;
                images.push(serde_json::json!({"view":view,"mode":mode,"resolution":size,"file":path.file_name().unwrap().to_string_lossy(),"submitted_faces":renderer.visible_faces,"shadow_faces":renderer.shadow_faces}));
            }
        }
    }
    let path: Vec<_> = (0..120)
        .map(|i| {
            let t = i as f64 / 120.0 * std::f64::consts::TAU;
            make(
                eye + DVec3::new(t.sin() * 8.0, 0.0, t.cos() * 8.0),
                glam::DQuat::from_rotation_y(t.sin() * 0.5) * direction,
            )
        })
        .collect();
    let mut moving = Vec::new();
    let ui = if recent {
        renderer.benchmark_ui()?
    } else {
        Vec::new()
    };
    let still = vec![uniforms; 120];
    let turn: Vec<_> = (0..120)
        .map(|i| {
            make(
                eye,
                glam::DQuat::from_rotation_y(
                    (i as f64 / 120.0 * std::f64::consts::TAU).sin() * 0.5,
                ) * direction,
            )
        })
        .collect();
    let paths = if recent {
        vec![
            ("stationary", &still),
            ("turn", &turn),
            ("moving", &path),
            ("moving_ui", &path),
        ]
    } else {
        vec![("moving", &path)]
    };
    for (motion, path) in paths {
        for size in if culling_only || recent {
            vec![[1280, 720], [2560, 1440]]
        } else {
            vec![[1280, 720]]
        } {
            if submission {
                let samples = renderer.benchmark_pair(
                    path,
                    size,
                    if motion == "moving_ui" { &ui } else { &[] },
                    [legacy, RenderProbe::default()],
                )?;
                for (mode, sample) in ["previous", "optimized"].into_iter().zip(samples) {
                    println!(
                        "Paired {motion} {size:?} {mode}: GPU {:.3}, encode {:.3}, serial {:.3}",
                        summary(&sample.gpu)["p50"].as_f64().unwrap(),
                        summary(&sample.cpu)["p50"].as_f64().unwrap(),
                        summary(&sample.wall)["p50"].as_f64().unwrap()
                    );
                    moving.push(serde_json::json!({"motion":motion,"mode":mode,"resolution":size,"batches":20,"warmup_per_batch":6,"samples_per_batch":24,
                        "gpu_ms":summary(&sample.gpu),"cpu_encode_ms":summary(&sample.cpu),"serial_frame_ms":summary(&sample.wall),
                        "raw_gpu_ms":sample.gpu,"raw_cpu_encode_ms":sample.cpu,"raw_serial_frame_ms":sample.wall,"dynamic_allocations":sample.allocations,"shadow_cache_hits":sample.shadow_hits}));
                }
                continue;
            }
            for round in 0..rounds {
                let variants = [
                    (
                        if recent {
                            "previous"
                        } else if culling_only {
                            "linear"
                        } else {
                            "legacy"
                        },
                        legacy,
                    ),
                    (
                        if culling_only {
                            "hierarchy"
                        } else {
                            "optimized"
                        },
                        RenderProbe::default(),
                    ),
                ];
                for i in if round % 2 == 0 { [0, 1] } else { [1, 0] } {
                    let (mode, options) = variants[i];
                    renderer.probe = options;
                    let (gpu, wall, cpu) = renderer.benchmark_paint_path(
                        path,
                        size,
                        if motion == "moving_ui" { &ui } else { &[] },
                    )?;
                    println!(
                        "{motion} {size:?} {round} {mode}: GPU {:.3}, encode {:.3}, serial {:.3}",
                        summary(&gpu)["p50"].as_f64().unwrap(),
                        summary(&cpu)["p50"].as_f64().unwrap(),
                        summary(&wall)["p50"].as_f64().unwrap()
                    );
                    moving.push(serde_json::json!({"motion":motion,"mode":mode,"round":round,"resolution":size,"gpu_ms":summary(&gpu),"cpu_encode_ms":summary(&cpu),"serial_frame_ms":summary(&wall),"raw_gpu_ms":gpu,"raw_cpu_encode_ms":cpu,"raw_serial_frame_ms":wall,"dynamic_allocations":renderer.benchmark_allocations,"shadow_cache_hits":renderer.benchmark_shadow_hits}));
                }
            }
        }
    }
    if culling_only || recent {
        renderer.probe = RenderProbe {
            validate_visibility: true,
            ..Default::default()
        };
        // Untimed: verify the exact ordered main/shadow block lists over movement.
        renderer.benchmark_path(&path, [1280, 720])?;
    }
    renderer.probe = RenderProbe::default();
    let resident = renderer.resident_faces();
    let compact_bytes = renderer.geometry_bytes();
    // Exercise packed local coordinates, transformed objects, emission and
    // transparency without changing the timed production scene above.
    for (i, material) in [1_u32, 2, 51, 101].into_iter().enumerate() {
        let center = eye + direction * 20.0 + DVec3::X * (i as f64 * 3.0 - 4.5);
        let color = (material << 24) | 0xf2a93b;
        let mesh = geometry::greedy_mesh([2, 2, 2], Vec3::ZERO, 1.0, |x, y, z| {
            if (0..2).contains(&x) && (0..2).contains(&y) && (0..2).contains(&z) {
                color
            } else {
                0
            }
        });
        renderer.upload(
            format!("probe-material-{i}"),
            &mesh,
            Mat4::from_rotation_translation(Quat::from_rotation_y(0.35), center.as_vec3()),
        )?;
    }
    for (mode, options) in [("legacy", legacy), ("optimized", RenderProbe::default())] {
        renderer.probe = options;
        let path = root.join(format!(
            "results/{prefix}-{world}-materials-{mode}-1280x720.png"
        ));
        renderer.draw_offscreen(uniforms, [1280, 720], &path)?;
        images.push(serde_json::json!({"view":"materials","mode":mode,"resolution":[1280,720],"file":path.file_name().unwrap().to_string_lossy()}));
    }
    for i in 0..4 {
        renderer.remove(&format!("probe-material-{i}"));
    }
    let validation = if recent {
        renderer.validate_frame_resources(uniforms, &ui)?
    } else {
        serde_json::Value::Null
    };
    renderer.probe = RenderProbe::default();
    let report = serde_json::json!({"device":renderer.device.name().to_string(),"world":world,"lod":lod,"quality":"Ultra","msaa":4,"shadow_map":4096,"render_scale":1,
        "resident_faces":resident,"old_face_bytes":resident*32,"compact_geometry_bytes":compact_bytes,"warmup_frames":24,"sample_frames":120,"rounds":rounds,"cases":cases,"images":images,"moving":moving,"frame_resource_validation":validation,
        "limitations":["Frozen 720p LOD selection; no LOD reduction between variants or output resolutions.","GPU and serial submit+completion timing, not displayed FPS; excludes streaming, physics and PNG readback.","UI is excluded except for moving_ui, which includes fixed egui mesh uploads/drawing but not layout or tessellation.","Movement cases rebuild visibility as the camera moves; still use fixed resident geometry.","Legacy buffers are allocated only for this diagnostic reference; reported compact bytes exclude visibility metadata/maps and render targets."]});
    atomic_write(
        &root.join(format!("results/{world}-{prefix}-profile.json")),
        &serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(())
}

/// Controlled pass reuse on a settled, static scene. This diagnoses avoided
/// work, not the independent duration of each GPU encoder or live gameplay FPS.
pub fn profile(
    renderer: &mut Renderer,
    uniforms: Uniforms,
    root: &Path,
    world: &str,
    lod: serde_json::Value,
    quads_only: bool,
) -> Result<()> {
    use crate::metal_renderer::RenderProbe;
    let normal = if quads_only {
        RenderProbe::legacy()
    } else {
        RenderProbe::default()
    };
    let mut probes = vec![
        (
            "reuse_shadow",
            RenderProbe {
                freeze_shadow: true,
                ..normal
            },
        ),
        (
            "reuse_secondary",
            RenderProbe {
                freeze_secondary: true,
                ..normal
            },
        ),
        (
            "reuse_bloom",
            RenderProbe {
                freeze_bloom: true,
                ..normal
            },
        ),
        (
            "no_post",
            RenderProbe {
                skip_post: true,
                ..normal
            },
        ),
        (
            "no_far",
            RenderProbe {
                skip_far: true,
                ..normal
            },
        ),
    ];
    if quads_only {
        probes = vec![(
            "grouped_32_quads",
            RenderProbe {
                grouped_quads: true,
                ..normal
            },
        )];
    }
    let mut cases = Vec::new();
    for size in [[1280, 720], [2560, 1440]] {
        for round in 0..2 {
            // Reverse the second round to expose order/thermal bias.
            let order: Vec<_> = if round == 0 {
                probes.iter().collect()
            } else {
                probes.iter().rev().collect()
            };
            for &(name, probe) in order {
                for (mode, options) in [("full", normal), (name, probe)] {
                    renderer.probe = options;
                    let (gpu, wall) = renderer.benchmark(uniforms, size, 24, 96)?;
                    let row = serde_json::json!({
                        "mode":mode,"paired_with":name,"round":round,"resolution":size,
                        "gpu_ms":summary(&gpu),"serial_frame_ms":summary(&wall),
                        "raw_gpu_ms":gpu,"raw_serial_frame_ms":wall,
                        "submitted_faces":renderer.visible_faces,"scene_draws":renderer.draw_calls,
                        "shadow_faces":renderer.shadow_faces,"shadow_draws":renderer.shadow_draws
                    });
                    println!(
                        "Profile {size:?} round {round} {mode}: GPU {:.3} ms, serial {:.3} ms, scene {} / shadow {} faces",
                        row["gpu_ms"]["p50"].as_f64().unwrap(),
                        row["serial_frame_ms"]["p50"].as_f64().unwrap(),
                        renderer.visible_faces,
                        renderer.shadow_faces
                    );
                    cases.push(row);
                    if quads_only && round == 1 {
                        renderer.draw_offscreen(
                            uniforms,
                            size,
                            &root.join(format!(
                                "results/profile-{mode}-{}x{}.png",
                                size[0], size[1]
                            )),
                        )?;
                    }
                }
            }
        }
    }
    renderer.probe = normal;
    let report = serde_json::json!({
        "device":renderer.device.name().to_string(),"world":world,"lod":lod,
        "warmup_frames":24,"sample_frames_per_case":96,"rounds":2,
        "resident_faces":renderer.resident_faces(),
        "face_bytes":std::mem::size_of::<space_native::geometry::Face>(),
        "cases":cases,
        "limitations":[
            "Settled static scene; no UI, streaming, physics, presentation or readback in timed samples.",
            "LOD is selected at 720p and frozen across resolutions; this is not the interactive window scene.",
            "Reuse probes retain the full baseline's textures at fixed camera and sky time; not independent per-pass timestamps.",
            "no_post changes image; no_far removes distant terrain. These are workload diagnostics, not quality-preserving optimizations.",
            "Paired deltas are not additive: GPU work overlaps and cache behavior changes."
        ]
    });
    atomic_write(
        &root.join(format!(
            "results/{world}-{}-profile.json",
            if quads_only { "topology" } else { "render" }
        )),
        &serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    schema: u32,
    profile: String,
    camera_position: [f32; 3],
    camera_quaternion: [f32; 4],
    flat_camera: [f64; 3],
    fov: f32,
    near: f32,
    far: f32,
    msaa: usize,
    draws: Vec<Draw>,
    total_vertices: usize,
    total_triangles: usize,
}
#[derive(Deserialize)]
struct Draw {
    file: String,
    sha256: String,
    vertices: usize,
    triangles: usize,
    masked: bool,
    side: u32,
}
pub(crate) fn summary(values: &[f64]) -> serde_json::Value {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let at = |p: f64| sorted[((sorted.len() - 1) as f64 * p) as usize];
    serde_json::json!({"count":values.len(),"mean":values.iter().sum::<f64>()/values.len() as f64,"p50":at(0.5),"p95":at(0.95),"p99":at(0.99),"max":sorted.last()})
}
pub fn run(root: &Path, source: &Path) -> Result<()> {
    let bytes = std::fs::read(source.join("manifest.json"))
        .context("Prepare the Web matched-lod-fine snapshot first")?;
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    ensure!(
        manifest.schema == 1 && manifest.msaa == 4,
        "Unsupported snapshot format/MSAA"
    );
    let mut renderer = Renderer::new(None)?;
    renderer.animate_sky = false;
    let mask = std::fs::read(source.join("mask.bin"))?;
    ensure!(
        mask.iter().all(|b| *b == 0 || *b == 255),
        "Snapshot must have settled terrain handoff"
    );
    renderer.upload_mask(&mask)?;
    let mut vertices = 0;
    let mut triangles = 0;
    for draw in &manifest.draws {
        ensure!(
            std::path::Path::new(&draw.file).components().count() == 1,
            "Invalid mesh filename"
        );
        let mut bytes = std::fs::read(source.join(&draw.file))?;
        ensure!(
            format!("{:x}", Sha256::digest(&bytes)) == draw.sha256,
            "Mesh hash differs: {}",
            draw.file
        );
        ensure!(bytes.len() >= 8, "Truncated replay mesh");
        let nv = u32::from_le_bytes(bytes[0..4].try_into()?) as usize;
        let ni = u32::from_le_bytes(bytes[4..8].try_into()?) as usize;
        ensure!(
            nv == draw.vertices && ni == draw.triangles * 3 && bytes.len() == 8 + nv * 32 + ni * 4,
            "Replay count mismatch"
        );
        for index in bytes[8 + nv * 32..].as_chunks::<4>().0 {
            ensure!(
                (u32::from_le_bytes(*index) as usize) < nv,
                "Replay index out of bounds"
            );
        }
        // Unmasked draws must not sample the near/far handoff texture.
        if !draw.masked {
            for vertex in bytes[8..8 + nv * 32].as_chunks_mut::<32>().0 {
                vertex[24..28].copy_from_slice(&(-1_f32).to_le_bytes());
            }
        }
        renderer.upload_replay(
            &bytes[8..8 + nv * 32],
            &bytes[8 + nv * 32..],
            draw.side == 0,
        )?;
        vertices += nv;
        triangles += ni / 3;
    }
    ensure!(
        vertices == manifest.total_vertices && triangles == manifest.total_triangles,
        "Missing snapshot geometry"
    );
    let mut cases = Vec::new();
    for ultra in [false, true] {
        for size in [[1280, 720], [2560, 1440], [3840, 2160]] {
            let eye = Vec3::from_array(manifest.camera_position);
            let view =
                Mat4::from_rotation_translation(Quat::from_array(manifest.camera_quaternion), eye)
                    .inverse();
            let clip = Mat4::perspective_rh(
                manifest.fov.to_radians(),
                size[0] as f32 / size[1] as f32,
                manifest.near,
                manifest.far,
            ) * view;
            let camera = DVec3::from_array(manifest.flat_camera)
                .as_vec3()
                .extend(0.0)
                .to_array();
            let u = Uniforms {
                clip: clip.to_cols_array_2d(),
                model: Mat4::IDENTITY.to_cols_array_2d(),
                camera,
                options: [
                    1.0,
                    if ultra { 1.0 } else { 0.0 },
                    0.0,
                    if ultra { 1.0 } else { 0.0 },
                ],
            };
            let mode = if ultra { "ultra" } else { "unlit-matched" };
            let (gpu, wall) = renderer.benchmark(u, size, 24, 120)?;
            let image = root.join(format!("results/{mode}-{}x{}.png", size[0], size[1]));
            renderer.draw_offscreen(u, size, &image)?;
            let report = serde_json::json!({"mode":mode,"resolution":size,"msaa":4,"shadow_map":if ultra{4096}else{0},"render_scale":1.0,"draw_calls":renderer.draw_calls,"triangles":triangles,"gpu_ms":summary(&gpu),"serial_frame_ms":summary(&wall),"raw_gpu_ms":gpu,"raw_serial_frame_ms":wall,"image":image});
            println!(
                "{} {}x{}: GPU p50 {:.3} ms / p95 {:.3} ms",
                mode,
                size[0],
                size[1],
                report["gpu_ms"]["p50"].as_f64().unwrap(),
                report["gpu_ms"]["p95"].as_f64().unwrap()
            );
            cases.push(report);
        }
    }
    let report = serde_json::json!({"device":renderer.device.name().to_string(),"backend":"Rust / Metal","profile":manifest.profile,"manifest_sha256":format!("{:x}",Sha256::digest(&bytes)),"mask_sha256":format!("{:x}",Sha256::digest(&mask)),"vertices":vertices,"triangles":triangles,"draws":manifest.draws.len(),"warmup_frames":24,"sample_frames":120,"cases":cases,"limitations":["Frozen Web draw snapshot: excludes live LOD selection/streaming, physics and UI.","Only unlit-matched is the original Web lighting workload. Ultra applies the native effects to the same geometry; Web Ultra visual equivalence is not yet certified.","GPU timestamps and serial submit+wait times are not displayed FPS. Geometry was selected at 1280x720 and remains fixed at higher resolutions.","Snapshot has no material IDs: Ultra replay cannot recover emission/transparency. Live native terrain retains them."]});
    atomic_write(
        &root.join("results/render-benchmark.json"),
        &serde_json::to_vec_pretty(&report)?,
    )?;
    Ok(())
}
