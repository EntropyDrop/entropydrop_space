#[cfg(target_os = "macos")]
mod app;
#[cfg(target_os = "macos")]
mod metal_renderer;
#[cfg(target_os = "macos")]
mod render_benchmark;
#[cfg(target_os = "macos")]
fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let value = |key: &str| {
        args.iter()
            .find_map(|s| s.strip_prefix(key))
            .map(str::to_owned)
    };
    let root = value("--root=")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let world = value("--world=").unwrap_or_else(|| "aether-archipelago".into());
    if args.iter().any(|a| a == "--validate-sky") {
        return metal_renderer::Renderer::new(None)?.validate_sky(&root.join("results"));
    }
    if args.iter().any(|a| a == "--benchmark") {
        let path = value("--matched=")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| root.join("../godot-space/matched-lod-fine/data"));
        return render_benchmark::run(&root, &path);
    }
    let profile_render = if args.iter().any(|a| a == "--profile-frameflow") {
        Some(9)
    } else if args.iter().any(|a| a == "--profile-gpu") {
        Some(8)
    } else if args.iter().any(|a| a == "--profile-leaves") {
        Some(7)
    } else if args.iter().any(|a| a == "--profile-groups") {
        Some(6)
    } else if args.iter().any(|a| a == "--profile-submission") {
        Some(5)
    } else if args.iter().any(|a| a == "--profile-frame-reuse") {
        Some(4)
    } else if args.iter().any(|a| a == "--profile-culling") {
        Some(3)
    } else if args.iter().any(|a| a == "--profile-optimized") {
        Some(2)
    } else if args.iter().any(|a| a == "--profile-quads") {
        Some(1)
    } else if args.iter().any(|a| a == "--profile-render") {
        Some(0)
    } else {
        None
    };
    if args.iter().any(|a| a == "--smoke") || profile_render.is_some() {
        return smoke(
            &root,
            &world,
            value("--lod-zones=")
                .map(|s| s.parse())
                .transpose()?
                .unwrap_or(0),
            profile_render,
        );
    }
    let event_loop = winit::event_loop::EventLoop::new()?;
    let mut application = app::Application::new(root, world);
    application.ui_test = args.iter().any(|a| a == "--ui-test")
        || std::env::var("SPACE_NATIVE_UI_TEST").as_deref() == Ok("1")
        || std::env::current_exe().ok().is_some_and(|p| {
            p.components()
                .any(|c| c.as_os_str() == "Space UI Validation.app")
        });
    if args.iter().any(|a| {
        a == "--profile-window-gpu"
            || a == "--profile-window-control"
            || a == "--profile-window-frameflow"
            || a == "--profile-window-streaming"
            || a == "--profile-window-startup"
    }) {
        use app::window_benchmark::Experiment;
        let experiment = if args.iter().any(|a| a == "--profile-window-startup") {
            Experiment::Startup
        } else if args.iter().any(|a| a == "--profile-window-streaming") {
            Experiment::Streaming
        } else if args.iter().any(|a| a == "--profile-window-frameflow") {
            Experiment::FrameFlow
        } else {
            Experiment::Packed
        };
        application.window_benchmark = Some(app::window_benchmark::WindowBenchmark::new(
            &application.root,
            args.iter().any(|a| a == "--profile-window-control"),
            experiment,
        ));
    }
    application.quit_after = value("--quit-after=").map(|s| s.parse()).transpose()?;
    event_loop.run_app(&mut application)?;
    if let Some(error) = application.error {
        return Err(error);
    }
    Ok(())
}
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Space Native currently requires macOS and Metal.");
    std::process::exit(1);
}

#[cfg(target_os = "macos")]
fn smoke(
    root: &std::path::Path,
    name: &str,
    lod_zones: usize,
    profile_render: Option<u8>,
) -> anyhow::Result<()> {
    anyhow::ensure!(lod_zones <= 128, "LOD zone count must be between 0 and 128");
    use glam::{DVec3, Mat4};
    use objc2_metal::MTLDevice;
    use space_native::{
        editor::Editor,
        geometry,
        world::{Cell, World, WorldSource, color},
    };
    let source = WorldSource::open(root.join("data/worlds").join(name))?;
    let spawn = DVec3::from_array(source.manifest.spawn);
    let mut world = World::new(source.clone());
    let cx = (spawn.x / 16.0).floor() as i32;
    let cz = (spawn.z / 16.0).floor() as i32;
    for z in cz - 3..=cz + 3 {
        for x in cx - 3..=cx + 3 {
            world.insert((x, z), source.load((x, z))?);
        }
    }
    let mut editor = Editor::default();
    let cell = Cell::new(cx * 16 + 4, 220, cz * 16 + 4, false);
    let original = world.get(cell);
    editor.edit(&mut world, [(cell, color(0xf2a93b, 0))]);
    anyhow::ensure!(world.get(cell) != original, "Edit failed");
    editor.undo(&mut world);
    anyhow::ensure!(world.get(cell) == original, "Undo failed");
    editor.redo(&mut world);
    // Exercise the actual Rust -> worker -> Rust contract, then submit returned
    // component geometry and poses to Metal in the same scene as terrain.
    let resource =
        space_native::protocol::decode(&std::fs::read(root.join("examples/entity.edpb"))?)?;
    editor.place(&mut world, &resource, spawn)?;
    let mut runtime = space_native::runtime::Runtime::new(&source.root);
    runtime.submit(
        &world,
        &editor.entities,
        editor.revision,
        space_native::runtime::Input {
            steps: 0,
            down: Vec::new(),
            clicks: Vec::new(),
            player: spawn.to_array(),
            driver: None,
        },
    )?;
    let frame = runtime
        .responses
        .recv_timeout(std::time::Duration::from_secs(30))??;
    let mut renderer = metal_renderer::Renderer::new(None)?;
    anyhow::ensure!(lod_zones <= 128, "LOD zones must be 0..128");
    let eye = spawn + DVec3::new(30.0, 25.0, 45.0);
    let mut lod_stats = serde_json::Value::Null;
    if lod_zones > 0 {
        let mut distant = space_native::distant::Distant::new(source.clone());
        loop {
            distant.request(space_native::distant::View {
                camera: eye.to_array(),
                height: 720,
                torus: true,
                edits: world.edits.iter().map(|(c, v)| (*c, *v)).collect(),
            });
            let frame = distant
                .responses
                .recv_timeout(std::time::Duration::from_secs(180))??;
            distant.busy = false;
            for tile in frame.tiles {
                renderer.upload_distant(&tile, true)?;
            }
            lod_stats = serde_json::json!({"zones":frame.zones,"refined_zones":frame.refined_zones,"source_bytes":frame.source_bytes,"selection":frame.stats});
            println!(
                "LOD: {}/128 zones, {} refined",
                frame.zones, frame.refined_zones
            );
            if frame.refined_zones >= lod_zones {
                break;
            }
        }
        let mut mask = vec![0_u8; 1024 * 128 * 2];
        for &(x, z) in world.chunks.keys() {
            mask[(z as usize * 1024 + x as usize) * 2] = 255;
        }
        renderer.upload_mask(&mask)?;
    }
    let mut faces = 0;
    let begin = std::time::Instant::now();
    let keys: Vec<_> = world.chunks.keys().copied().collect();
    for key in keys {
        let mesh = world.mesh(key);
        faces += mesh.len();
        renderer.upload(format!("chunk:{}:{}", key.0, key.1), &mesh, Mat4::IDENTITY)?;
    }
    for entity in &frame.entities {
        for node in &entity.nodes {
            let model = Mat4::from_cols_array(&node.model);
            let mesh =
                space_native::runtime::voxel_faces(node.voxels.as_deref().unwrap_or_default());
            faces += mesh.len();
            renderer.upload(format!("entity:{}:{}", entity.id, node.id), &mesh, model)?;
            for decoration in &node.decorations {
                let (mesh, model) = space_native::runtime::decoration_mesh(decoration, model);
                faces += mesh.len();
                renderer.upload(
                    format!("entity:{}:{}:{}", entity.id, node.id, decoration.id),
                    &mesh,
                    model,
                )?;
            }
        }
    }
    let mesh_and_upload_ms = begin.elapsed().as_secs_f64() * 1000.0;
    let eye = spawn + DVec3::new(30.0, 25.0, 45.0);
    let direction = (spawn - DVec3::Y * 25.0 - eye).normalize();
    let uniform = metal_renderer::Uniforms {
        clip: geometry::camera_matrix(eye, direction, 16.0 / 9.0, true).to_cols_array_2d(),
        model: Mat4::IDENTITY.to_cols_array_2d(),
        camera: [eye.x as f32, eye.y as f32, eye.z as f32, 0.0],
        options: [1.0, 1.0, 0.0, 1.0],
    };
    if let Some(mode) = profile_render {
        if mode == 6 {
            return render_benchmark::groups(&mut renderer, uniform, root, name, lod_stats);
        }
        if mode >= 2 {
            return render_benchmark::optimized(
                &mut renderer,
                uniform,
                root,
                name,
                lod_stats,
                mode,
            );
        }
        return render_benchmark::profile(&mut renderer, uniform, root, name, lod_stats, mode == 1);
    }
    let suffix = if lod_zones > 0 { "lod-smoke" } else { "smoke" };
    let path = root.join("results").join(format!("{name}-{suffix}.png"));
    let timing = if lod_zones > 0 {
        let (gpu, wall) = renderer.benchmark(uniform, [1280, 720], 24, 120)?;
        serde_json::json!({"gpu_ms":render_benchmark::summary(&gpu),"serial_frame_ms":render_benchmark::summary(&wall)})
    } else {
        serde_json::Value::Null
    };
    renderer.draw_offscreen(uniform, [1280, 720], &path)?;
    let report = serde_json::json!({"world":name,"renderer":"Metal","device":renderer.device.name().to_string(),"chunks":world.chunks.len(),"near_faces":faces,"submitted_faces":renderer.visible_faces,"triangles":renderer.visible_faces*2,"resolution":[1280,720],"quality":"Ultra / full resolution","msaa":4,"shadow_map":4096,"draw_calls":renderer.draw_calls,"gpu_ms":renderer.gpu_ms,"mesh_and_upload_ms":mesh_and_upload_ms,"resident_faces":renderer.resident_faces(),"lod":lod_stats,"timing":timing,"edit_undo_redo":true,"entity_runtime":true,"entities":frame.entities.len(),"image":path,"note":"Smoke validation; not a matched-workload performance benchmark"});
    space_native::storage::atomic_write(
        &root.join("results").join(format!("{name}-{suffix}.json")),
        &serde_json::to_vec_pretty(&report)?,
    )?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
