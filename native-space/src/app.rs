use crate::metal_renderer::{Renderer, Uniforms};
use space_native::{
    avatar::Avatar,
    interaction::{self, HotbarTool},
};
#[path = "audio.rs"]
mod audio;
#[path = "desktop_ui.rs"]
mod desktop_ui;
#[path = "entity_preview.rs"]
mod entity_preview;
#[path = "file_dialog.rs"]
mod file_dialog;
#[path = "gameplay.rs"]
mod gameplay;
#[path = "hud.rs"]
mod hud;
#[path = "window_benchmark.rs"]
pub mod window_benchmark;
use anyhow::{Context, Result};
use glam::{DVec3, Mat4};
use space_native::{
    camera::Camera,
    editor::{Editor, Tool},
    geometry, protocol,
    runtime::{self, Driver, Frame, Runtime},
    storage,
    streaming::Streaming,
    world::{World, WorldSource},
};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use winit::{
    application::ApplicationHandler,
    event::{DeviceEvent, ElementState, MouseButton, MouseScrollDelta, WindowEvent},
    event_loop::{ActiveEventLoop, ControlFlow},
    keyboard::{KeyCode, ModifiersState, PhysicalKey},
    window::{CursorGrabMode, Window, WindowId},
};
type Key = (i32, i32);
type MeshResult = (Key, Vec<geometry::Face>);

pub struct Game {
    ephemeral: bool,
    audio: audio::Audio,
    pending_clicks: Vec<runtime::Click>,
    pub world: World,
    pub camera: Camera,
    pub editor: Editor,
    streaming: Streaming,
    near_demand: space_native::streaming::NearDemand,
    stream_optimized: bool,
    distant: space_native::distant::Distant,
    distant_tiles: std::collections::VecDeque<space_native::distant::Tile>,
    distant_status: String,
    distant_failed: bool,
    distant_ready: bool,
    distant_zones: usize,
    last_lod: Instant,
    last_lod_view: Option<([f64; 3], u32, bool, u64)>,
    near_ready: HashSet<Key>,
    mask_dirty: bool,
    lod_publishing: bool,
    lod_projection: bool,
    meshes_inflight: HashSet<Key>,
    mesh_tx: crossbeam_channel::Sender<MeshResult>,
    mesh_rx: crossbeam_channel::Receiver<MeshResult>,
    pool: rayon::ThreadPool,
    pub status: String,
    pub torus: bool,
    pub lit: bool,
    pub radius: i32,
    pub vsync: bool,
    pub path: String,
    pub panel: Panel,
    pub saved_revision: u64,
    save_path: PathBuf,
    pub capture: Option<PathBuf>,
    pub save_elapsed: f64,
    pub dropped_meshes: usize,
    runtime: Runtime,
    runtime_error: Option<String>,
    runtime_frame: Option<Frame>,
    simulation_elapsed: f64,
    driver: Option<Driver>,
    decoration_colors: HashMap<String, (u32, u32)>,
    runtime_geometry: HashMap<String, Vec<[f64; 6]>>,
    pending_world: Option<String>,
    active_tool: HotbarTool,
    panel_open: bool,
    capture_request: Option<bool>,
    selecting: bool,
    held_tool: Option<bool>,
    stroke_elapsed: f64,
    grab: Option<gameplay::Grab>,
    model_drag: Option<gameplay::ModelDrag>,
    last_grab_click: Option<(String, Instant)>,
    preview_dirty: bool,
    preview_parts: Vec<(String, Mat4)>,
    avatar: Avatar,
    avatar_mode: Option<u8>,
    avatar_phase: f32,
    previous_position: DVec3,
    perspective: u8,
    model_size: [f32; 3],
    interface: space_native::ui_state::UiState,
    entity_preview: entity_preview::Preview,
    gizmo_before: Option<space_native::editor::PlacedEntity>,
    gizmo_origin: DVec3,
    gizmo_pointer: egui::Pos2,
    minimap: space_native::minimap::Minimap,
    map_refresh: Instant,
    import_job: Option<crossbeam_channel::Receiver<Result<protocol::inventory::InventoryResource>>>,
}
#[derive(Clone, Copy, PartialEq)]
pub enum Panel {
    Build,
    Entities,
}
impl Game {
    pub fn open(root: &Path, name: &str) -> Result<Self> {
        let source = WorldSource::open(root.join("data/worlds").join(name)).with_context(|| {
            format!("Prepare world first: node native-space/tools/terrain.ts --world={name}")
        })?;
        let mut world = World::new(source.clone());
        let mut camera = Camera::overlooking(DVec3::from_array(source.manifest.spawn));
        let mut editor = Editor::default();
        let save_path = root.join("saves").join(format!("{name}.json.gz"));
        let mut perspective = 0;
        let mut interface = space_native::ui_state::UiState::default();
        if save_path.exists() && name != "tutorial" {
            let s = storage::load(&save_path, name, &source.manifest.source_hash)?;
            camera.position = DVec3::from_array(s.position);
            camera.yaw = s.yaw;
            camera.pitch = s.pitch;
            world.edits = s.edits.into_iter().collect();
            editor.entities = s.entities;
            editor.backpack = match s.backpack_state {
                Some(state) => state,
                None => space_native::backpack::Backpack::from_legacy(s.backpack)?,
            };
            perspective = s.perspective.min(2);
            if let Some(mut preferences) = s.preferences {
                preferences.normalize();
                interface.preferences = preferences;
            }
        }
        if name == "tutorial" {
            space_native::tutorial::load(&mut world, &mut editor, &mut camera)?;
        }
        let (mesh_tx, mesh_rx) = crossbeam_channel::bounded(8);
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .thread_name(|i| format!("space-mesher-{i}"))
            .build()?;
        let runtime = Runtime::new(&source.root);
        let avatar = interface
            .preferences
            .skin_path
            .as_ref()
            .and_then(|path| std::fs::read(path).ok())
            .and_then(|bytes| Avatar::from_png_style(&bytes, interface.preferences.slim_skin).ok())
            .unwrap_or(Avatar::bundled()?);
        let entry = &interface.preferences.palette.entries[interface.preferences.palette.selected];
        editor.rgb = space_native::palette::sample(entry, 0.0);
        editor.material = entry.material_id;
        editor.gradient = Some(entry.clone());
        Ok(Self {
            ephemeral: false,
            audio: Default::default(),
            pending_clicks: Vec::new(),
            previous_position: camera.position,
            world,
            camera,
            editor,
            streaming: Streaming::new(source.clone()),
            near_demand: Default::default(),
            stream_optimized: std::env::var("SPACE_NATIVE_LEGACY_STREAMING").as_deref() != Ok("1"),
            distant: space_native::distant::Distant::new(source.clone()),
            distant_tiles: Default::default(),
            distant_status: "Generating volumetric LOD…".into(),
            distant_failed: false,
            distant_ready: false,
            distant_zones: 0,
            last_lod: Instant::now(),
            last_lod_view: None,
            near_ready: HashSet::new(),
            mask_dirty: true,
            lod_publishing: false,
            lod_projection: true,
            meshes_inflight: HashSet::new(),
            mesh_tx,
            mesh_rx,
            pool,
            status: "Loading world…".into(),
            torus: true,
            lit: true,
            radius: 7,
            vsync: true,
            path: root
                .join("exports/item.edpb")
                .to_string_lossy()
                .into_owned(),
            panel: Panel::Build,
            saved_revision: 0,
            save_path,
            capture: None,
            save_elapsed: 0.0,
            dropped_meshes: 0,
            runtime,
            runtime_error: None,
            runtime_frame: None,
            simulation_elapsed: 0.0,
            driver: None,
            decoration_colors: HashMap::new(),
            runtime_geometry: HashMap::new(),
            pending_world: None,
            active_tool: HotbarTool::Select,
            panel_open: false,
            capture_request: None,
            selecting: false,
            held_tool: None,
            stroke_elapsed: 0.0,
            grab: None,
            model_drag: None,
            last_grab_click: None,
            preview_dirty: true,
            preview_parts: Vec::new(),
            avatar,
            avatar_mode: None,
            avatar_phase: 0.0,
            perspective,
            model_size: interface.preferences.modeling_size,
            interface,
            entity_preview: Default::default(),
            gizmo_before: None,
            gizmo_origin: DVec3::ZERO,
            gizmo_pointer: egui::Pos2::ZERO,
            minimap: Default::default(),
            map_refresh: Instant::now(),
            import_job: None,
        })
    }
    pub fn save(&mut self) -> Result<()> {
        if self.ephemeral || self.world.source.manifest.world == "tutorial" {
            self.save_elapsed = 0.0;
            return Ok(());
        }
        let save = storage::Save {
            schema: 1,
            world: self.world.source.manifest.world.clone(),
            source_hash: self.world.source.manifest.source_hash.clone(),
            position: self.camera.position.to_array(),
            yaw: self.camera.yaw,
            pitch: self.camera.pitch,
            edits: self.world.edits.iter().map(|(k, v)| (*k, *v)).collect(),
            entities: self.editor.entities.clone(),
            backpack: self.editor.backpack.legacy_resources(),
            backpack_state: Some(self.editor.backpack.clone()),
            perspective: self.perspective,
            preferences: Some(self.interface.preferences.clone()),
        };
        storage::save(&self.save_path, &save)?;
        self.saved_revision = self.editor.revision;
        self.save_elapsed = 0.0;
        Ok(())
    }
    pub fn import(&mut self, path: &Path) -> Result<()> {
        let bytes = std::fs::read(path)?;
        let resource = protocol::decode(&bytes)?;
        self.editor.backpack.insert(resource.clone())?;
        self.editor.clipboard = Some(resource);
        self.preview_dirty = true;
        self.editor.revision += 1;
        self.status = format!("Imported {}", path.display());
        Ok(())
    }
    pub fn stream(&mut self, renderer: &mut Renderer) -> Result<()> {
        let cx = (self.camera.position.x / 16.0).floor() as i32;
        let cz = (self.camera.position.z / 16.0).floor() as i32;
        self.near_demand
            .update(cx, cz, self.radius, !self.stream_optimized);
        if !self.near_demand.complete {
            self.near_demand.complete = true;
            for &key in &self.near_demand.keys {
                if !self.world.chunks.contains_key(&key) {
                    self.near_demand.complete = false;
                    self.streaming.request(key);
                }
            }
        }
        let started = Instant::now();
        while let Ok((key, result)) = self.streaming.responses.try_recv() {
            self.streaming.pending.remove(&key);
            match result {
                Ok(chunk) => self.world.insert(key, chunk),
                Err(error) => {
                    self.status = format!("Terrain: {error:#}");
                }
            }
            if started.elapsed() > Duration::from_millis(3) {
                break;
            }
        }
        while let Ok((key, faces)) = self.mesh_rx.try_recv() {
            self.meshes_inflight.remove(&key);
            if self.world.dirty.contains(&key) || !self.world.chunks.contains_key(&key) {
                self.dropped_meshes += 1;
                continue;
            }
            renderer.upload(format!("chunk:{}:{}", key.0, key.1), &faces, Mat4::IDENTITY)?;
            self.near_ready.insert(key);
            self.mask_dirty = true;
            if started.elapsed() > Duration::from_millis(5) {
                break;
            }
        }
        let mut dirty: Vec<Key> = self
            .world
            .dirty
            .iter()
            .copied()
            .filter(|k| !self.meshes_inflight.contains(k))
            .collect();
        dirty.sort_by_key(|k| (k.0 - cx).pow(2) + (k.1 - cz).pow(2));
        for key in dirty
            .into_iter()
            .take(4_usize.saturating_sub(self.meshes_inflight.len()))
        {
            self.world.dirty.remove(&key);
            if !self.world.chunks.contains_key(&key) {
                continue;
            }
            let mut chunks = HashMap::new();
            for dx in -1..=1 {
                for dz in -1..=1 {
                    let k = ((key.0 + dx).rem_euclid(1024), (key.1 + dz).rem_euclid(128));
                    if let Some(c) = self.world.chunks.get(&k) {
                        chunks.insert(k, Arc::clone(c));
                    }
                }
            }
            let snapshot = World {
                source: self.world.source.clone(),
                chunks,
                edits: Default::default(),
                dirty: Default::default(),
                revision: self.world.revision,
            };
            let sender = self.mesh_tx.clone();
            self.meshes_inflight.insert(key);
            self.pool.spawn(move || {
                let mesh = snapshot.mesh(key);
                let _ = sender.send((key, mesh));
            });
        }
        let unload: Vec<Key> = self
            .world
            .chunks
            .keys()
            .copied()
            .filter(|k| {
                let dx = geometry::wrap_near(k.0 as f64, cx as f64, 1024.0) - cx as f64;
                let dz = geometry::wrap_near(k.1 as f64, cz as f64, 128.0) - cz as f64;
                dx.abs() > (self.radius + 3) as f64 || dz.abs() > (self.radius + 3) as f64
            })
            .collect();
        for key in unload {
            self.world.chunks.remove(&key);
            self.world.dirty.remove(&key);
            renderer.remove(&format!("chunk:{}:{}", key.0, key.1));
            self.near_ready.remove(&key);
            self.mask_dirty = true;
        }
        if self.mask_dirty {
            let mut mask = vec![0_u8; 1024 * 128 * 2];
            for &(x, z) in &self.near_ready {
                mask[(z as usize * 1024 + x as usize) * 2] = 255;
            }
            renderer.upload_mask(&mask)?;
            self.mask_dirty = false;
        }
        if let Ok(result) = self.distant.responses.try_recv() {
            self.lod_publishing = true;
            match result {
                Ok(frame) => {
                    self.distant_failed = false;
                    self.distant_ready = frame.ready;
                    self.distant_zones = frame.zones;
                    self.lod_projection = frame.torus;
                    self.distant_status = format!(
                        "LOD {}/128 zones · refined {}/128 · {} restored · {:.1} MiB source · requested 1 px² / effective {:.2} px² · {} source-limited zones",
                        frame.zones,
                        frame.refined_zones,
                        frame.cache_restored_zones,
                        frame.source_bytes as f64 / 1048576.0,
                        frame.stats["effectiveAreaPx2"].as_f64().unwrap_or(1.0),
                        frame.source_limited_zones
                    );
                    self.distant_tiles.extend(frame.tiles);
                }
                Err(e) => {
                    self.distant_status = format!("LOD error: {e:#}");
                    self.distant_failed = true;
                    self.distant_ready = false;
                    self.last_lod = Instant::now();
                }
            }
        }
        let uploads = Instant::now();
        while let Some(tile) = self.distant_tiles.pop_front() {
            renderer.upload_distant(&tile, self.lod_projection)?;
            if uploads.elapsed() > Duration::from_millis(4) {
                break;
            }
        }
        if self.lod_publishing && self.distant_tiles.is_empty() {
            self.distant.busy = false;
            self.lod_publishing = false;
        }
        let view = (
            self.camera.position.to_array(),
            renderer.frame_height().max(720),
            self.torus,
            self.world.revision,
        );
        let delay = if self.distant_failed {
            1000
        } else if self.stream_optimized && !self.distant_ready {
            0
        } else {
            500
        };
        if !self.distant.busy
            && self.distant_tiles.is_empty()
            && self.last_lod.elapsed() >= Duration::from_millis(delay)
            && (!self.stream_optimized || !self.distant_ready || self.last_lod_view != Some(view))
            && self.distant.request(space_native::distant::View {
                camera: view.0,
                height: view.1,
                torus: view.2,
                edits: self.world.edits.iter().map(|(c, v)| (*c, *v)).collect(),
            })
        {
            self.last_lod = Instant::now();
            self.last_lod_view = Some(view);
        }
        if self.status == "Loading world…"
            && self.streaming.pending.is_empty()
            && self.meshes_inflight.is_empty()
            && !self.world.chunks.is_empty()
        {
            self.status = "Ready · Local world".into();
        }
        Ok(())
    }
    fn simulate(&mut self, renderer: &mut Renderer, dt: f64, down: Vec<String>) -> Result<()> {
        self.simulation_elapsed = (self.simulation_elapsed + dt).min(0.1);
        if let Ok(result) = self.runtime.responses.try_recv() {
            self.runtime.busy = false;
            match result {
                Err(error) => {
                    let error = format!("{error:#}");
                    self.status = error.clone();
                    self.runtime_error = Some(error);
                    self.driver = None;
                }
                Ok(frame) => {
                    let mut keep = HashSet::new();
                    for state in &frame.entities {
                        let Some(entity) =
                            self.editor.entities.iter_mut().find(|e| e.id == state.id)
                        else {
                            continue;
                        };
                        if frame.epoch == self.editor.revision && entity.running && !state.running {
                            entity.running = false;
                            self.editor.revision += 1;
                        }
                        for node in &state.nodes {
                            let key = interaction::entity_mesh_key(&state.id, &node.id);
                            let model = Mat4::from_cols_array(&node.model);
                            keep.insert(key.clone());
                            keep.insert(format!("{key}:alpha"));
                            if let Some(voxels) = &node.voxels {
                                self.runtime_geometry.insert(key.clone(), voxels.clone());
                                renderer.upload(
                                    key.clone(),
                                    &runtime::voxel_faces(voxels),
                                    model,
                                )?;
                            }
                            renderer.set_model(&key, model);
                            for d in &node.decorations {
                                let key =
                                    interaction::decoration_mesh_key(&state.id, &node.id, &d.id);
                                let (faces, model) = runtime::decoration_mesh(d, model);
                                if self.decoration_colors.get(&key) != Some(&(d.color, d.material))
                                    || !renderer.has_mesh(&key)
                                {
                                    renderer.upload(key.clone(), &faces, model)?;
                                    self.decoration_colors
                                        .insert(key.clone(), (d.color, d.material));
                                }
                                renderer.set_model(&key, model);
                                keep.insert(key.clone());
                                keep.insert(format!("{key}:alpha"));
                            }
                            if let Some(driver) = &self.driver
                                && driver.id == state.id
                                && driver.component == node.id
                                && let Some(seat) =
                                    node.seats.iter().find(|s| s.index == driver.seat)
                            {
                                self.camera.position =
                                    DVec3::from_array(seat.position) + DVec3::Y * 1.15;
                            }
                        }
                    }
                    renderer.retain_meshes(|key| !key.starts_with("entity:") || keep.contains(key));
                    self.decoration_colors.retain(|key, _| keep.contains(key));
                    self.runtime_geometry.retain(|key, _| keep.contains(key));
                    // New local user edits win over a simulation reply based on
                    // an older snapshot. The next request repairs worker state.
                    let changes: Vec<_> = frame
                        .mutations
                        .iter()
                        .filter(|(cell, _)| {
                            self.world.edits.get(cell) == self.runtime.sent_edits.get(cell)
                        })
                        .copied()
                        .collect();
                    self.editor.edit(&mut self.world, changes);
                    if let Some(driver) = &self.driver
                        && !frame.entities.iter().any(|e| e.id == driver.id)
                    {
                        self.driver = None;
                    }
                    self.runtime_frame = Some(frame);
                }
            }
        }
        if self.runtime_error.is_none()
            && !self.runtime.busy
            && self.simulation_elapsed >= 1.0 / 60.0
            && (!self.editor.entities.is_empty() || self.runtime_frame.is_some())
        {
            let steps = ((self.simulation_elapsed * 60.0).floor() as usize).min(5);
            match self.runtime.submit(
                &self.world,
                &self.editor.entities,
                self.editor.revision,
                runtime::Input {
                    steps,
                    down,
                    player: self.camera.position.to_array(),
                    driver: self.driver.clone(),
                    clicks: self.pending_clicks.clone(),
                },
            ) {
                Ok(()) => {
                    self.simulation_elapsed = 0.0;
                    self.pending_clicks.clear();
                }
                Err(e) => {
                    self.runtime_error = Some(format!("{e:#}"));
                    self.status = format!("Simulation: {e:#}");
                }
            }
        }
        Ok(())
    }
    pub fn uniforms(&self, size: [u32; 2]) -> Uniforms {
        let (eye, direction) = self.view();
        Uniforms {
            clip: geometry::camera_matrix_fov(
                eye,
                direction,
                size[0] as f32 / size[1].max(1) as f32,
                self.torus,
                self.interface.preferences.fov as f32,
            )
            .to_cols_array_2d(),
            model: Mat4::IDENTITY.to_cols_array_2d(),
            camera: [eye.x as f32, eye.y as f32, eye.z as f32, 0.0],
            options: [
                if self.torus { 1.0 } else { 0.0 },
                if self.lit { 1.0 } else { 0.0 },
                0.0,
                1.0,
            ],
        }
    }
    fn result(&mut self, result: Result<()>) {
        if let Err(e) = result {
            self.status = format!("{e:#}");
        }
    }
    fn settings_ui(&mut self, ui: &mut egui::Ui, renderer: &Renderer) {
        ui.heading("World & rendering");
        ui.label("Ultra · full resolution · 4x MSAA · 4096 shadows");
        let [w, h] = renderer.frame_size();
        ui.label(format!("{w} × {h} physical pixels · 100% scale"));
        ui.label("HDR · clouds · contact shadows · shafts · bloom · AgX · FXAA");
        ui.label(&self.distant_status);
        ui.checkbox(&mut self.torus, "Torus projection");
        ui.checkbox(&mut self.lit, "Directional lighting");
        ui.horizontal_wrapped(|ui| {
            for name in ["nature", "copper-metropolis", "aether-archipelago"] {
                if ui.button(name).clicked() {
                    self.pending_world = Some(name.into());
                }
            }
        });
        ui.checkbox(&mut self.camera.flying, "Fly");
        ui.add(egui::Slider::new(&mut self.camera.speed, 1.0..=120.0).text("Flight speed"));
        ui.add(egui::Slider::new(&mut self.radius, 2..=12).text("Loaded radius"));
        ui.label("Distance haze follows the Ultra preset");
        if ui.checkbox(&mut self.vsync, "VSync").changed() {
            renderer.set_vsync(self.vsync);
        }
        if ui.button("Return to spawn").clicked() {
            self.camera = Camera::overlooking(DVec3::from_array(self.world.source.manifest.spawn));
        }
        if ui.button("Screenshot  F12").clicked() {
            self.capture = Some(
                self.save_path
                    .parent()
                    .unwrap()
                    .join(format!("screenshot-{}.png", uuid::Uuid::new_v4())),
            );
        }
        ui.separator();
        ui.label(format!("{} resident chunks\n{} pending loads\n{} mesh jobs\n{} visible faces\n{} draw calls\n{} edited cells",self.world.chunks.len(),self.streaming.pending.len(),self.meshes_inflight.len(),renderer.visible_faces,renderer.draw_calls,self.world.edits.len()));
        ui.label(format!(
            "Position: {:.1}, {:.1}, {:.1}",
            self.camera.position.x, self.camera.position.y, self.camera.position.z
        ));
    }
}
fn pointer_over_ui(ctx: &egui::Context, cursor: Option<egui::Pos2>) -> bool {
    cursor
        .and_then(|p| ctx.layer_id_at(p))
        .is_some_and(|layer| layer.order != egui::Order::Background)
}

pub struct Application {
    pub root: PathBuf,
    pub world_name: String,
    window: Option<Window>,
    renderer: Option<Renderer>,
    egui: egui::Context,
    input: Option<egui_winit::State>,
    game: Option<Game>,
    keys: HashSet<KeyCode>,
    modifiers: ModifiersState,
    last_jump: Option<Instant>,
    cursor: Option<egui::Pos2>,
    captured: bool,
    last: Instant,
    frame_rate: space_native::frame_metrics::FrameRate,
    pub error: Option<anyhow::Error>,
    pub quit_after: Option<f64>,
    pub ui_test: bool,
    pub window_benchmark: Option<window_benchmark::WindowBenchmark>,
    started: Instant,
}

impl Application {
    pub fn new(root: PathBuf, world_name: String) -> Self {
        let ctx = egui::Context::default();
        ctx.set_visuals(egui::Visuals::dark());
        Self {
            root,
            world_name,
            window: None,
            renderer: None,
            egui: ctx,
            input: None,
            game: None,
            keys: HashSet::new(),
            modifiers: ModifiersState::empty(),
            last_jump: None,
            cursor: None,
            captured: false,
            last: Instant::now(),
            frame_rate: Default::default(),
            error: None,
            quit_after: None,
            ui_test: false,
            window_benchmark: None,
            started: Instant::now(),
        }
    }
    fn capture(&mut self, value: bool) {
        if !value {
            self.keys.clear();
            self.last_jump = None;
        }
        if let Some(w) = &self.window {
            let result = if value {
                w.set_cursor_grab(CursorGrabMode::Locked)
                    .or_else(|_| w.set_cursor_grab(CursorGrabMode::Confined))
            } else {
                w.set_cursor_grab(CursorGrabMode::None)
            };
            self.captured = value && result.is_ok();
            w.set_cursor_visible(!self.captured);
        }
    }
    fn draw(&mut self, event_loop: &ActiveEventLoop) -> Result<()> {
        // An already queued redraw can arrive after a benchmark requests exit.
        if event_loop.exiting() {
            return Ok(());
        }
        let window = self.window.as_ref().context("Window missing")?;
        let size = window.inner_size();
        if size.width == 0 || size.height == 0 {
            return Ok(());
        }
        let dt = self.last.elapsed().as_secs_f64();
        self.last = Instant::now();
        let game = self.game.as_mut().context("Game missing")?;
        let renderer = self.renderer.as_mut().unwrap();
        if let Some(benchmark) = &self.window_benchmark {
            benchmark.before_frame(game, renderer);
        }
        if let Some(result) = game.import_job.as_ref().and_then(|job| job.try_recv().ok()) {
            game.import_job = None;
            match result {
                Ok(resource) => {
                    let r = game.editor.backpack.insert(resource.clone()).map(|_| ());
                    if r.is_ok() {
                        game.editor.clipboard = Some(resource);
                        game.choose_tool(HotbarTool::Hammer);
                        game.editor.revision += 1;
                        game.close_modal();
                        game.status = "Model imported · click to pin a preview".into();
                    }
                    game.result(r);
                }
                Err(e) => game.status = format!("Import failed: {e:#}"),
            }
        }
        if let Err(e) = game.audio.update(game.interface.preferences.music) {
            game.status = e.to_string();
        }
        game.stream(renderer)?;
        game.simulate(
            renderer,
            dt,
            if self.captured {
                self.keys
                    .iter()
                    .filter(|k| !space_native::interaction::reserved_script_key(&format!("{k:?}")))
                    .map(|k| format!("{k:?}"))
                    .collect()
            } else {
                Vec::new()
            },
        )?;
        if let Some(target) = game.interface.navigation_target {
            let delta = DVec3::new(
                geometry::wrap_near(target.x, game.camera.position.x, 16384.0)
                    - game.camera.position.x,
                target.y - game.camera.position.y,
                geometry::wrap_near(target.z, game.camera.position.z, 2048.0)
                    - game.camera.position.z,
            );
            if delta.length() < 0.5 {
                game.interface.navigation_target = None;
            } else {
                game.camera.position +=
                    delta.normalize() * ((game.camera.speed * dt).min(delta.length()));
            }
        }
        if self.captured && game.driver.is_none() {
            let pressed = |key| if self.keys.contains(&key) { 1.0 } else { 0.0 };
            game.camera.update(
                &game.world,
                DVec3::new(
                    pressed(KeyCode::KeyD) - pressed(KeyCode::KeyA),
                    pressed(KeyCode::Space)
                        - pressed(KeyCode::ShiftLeft).max(pressed(KeyCode::ShiftRight)),
                    pressed(KeyCode::KeyW) - pressed(KeyCode::KeyS),
                ),
                self.modifiers.control_key(),
                self.keys.contains(&KeyCode::Space),
                dt,
            );
        }
        game.update_gameplay(renderer, dt, self.captured)?;
        game.save_elapsed += dt;
        if game.save_elapsed >= 30.0
            && let Err(e) = game.save()
        {
            game.status = format!("Save failed: {e:#}");
            game.save_elapsed = 0.0;
        }
        let input = self.input.as_mut().unwrap();
        let output = self.egui.run(input.take_egui_input(window), |ctx| {
            game.ui(ctx, renderer, self.frame_rate.fps(), self.captured)
        });
        input.handle_platform_output(window, output.platform_output);
        renderer.update_textures(&output.textures_delta)?;
        let paint = self.egui.tessellate(output.shapes, output.pixels_per_point);
        let capture = game.capture.take();
        let render_started = Instant::now();
        let submitted = renderer.draw(
            game.uniforms([size.width, size.height]),
            &paint,
            output.pixels_per_point,
            capture.as_deref(),
        )?;
        self.frame_rate
            .record(self.started.elapsed().as_secs_f64(), submitted);
        renderer.free_textures(&output.textures_delta.free);
        if let Some(benchmark) = &mut self.window_benchmark
            && benchmark.after_frame(
                game,
                renderer,
                [size.width, size.height],
                submitted,
                [
                    render_started.duration_since(self.last).as_secs_f64() * 1000.0,
                    render_started.elapsed().as_secs_f64() * 1000.0,
                ],
            )?
        {
            event_loop.exit();
            return Ok(());
        }
        let capture_request = game.capture_request.take();
        if let Some(name) = game.pending_world.take() {
            match game.save().and_then(|_| Game::open(&self.root, &name)) {
                Ok(mut next) => {
                    next.editor.backpack = game.editor.backpack.clone();
                    next.interface.preferences = game.interface.preferences.clone();
                    renderer.retain_meshes(|_| false);
                    let ephemeral = game.ephemeral;
                    *game = next;
                    game.ephemeral = ephemeral;
                    self.world_name = name;
                }
                Err(e) => game.status = format!("World change failed: {e:#}"),
            }
        }
        if self
            .quit_after
            .is_some_and(|limit| self.started.elapsed().as_secs_f64() > limit)
        {
            game.save()?;
            event_loop.exit();
        }
        if let Some(capture) = capture_request {
            if !capture {
                self.keys.clear();
            }
            self.capture(capture);
        }
        Ok(())
    }
}
impl ApplicationHandler for Application {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        let result = (|| -> Result<()> {
            let mut attributes = Window::default_attributes()
                .with_title("Space · Native Metal")
                .with_inner_size(winit::dpi::LogicalSize::new(1440.0, 900.0));
            if self.window_benchmark.is_some() {
                attributes = attributes
                    .with_inner_size(winit::dpi::PhysicalSize::new(2560, 1440))
                    .with_resizable(false);
            }
            let window = event_loop.create_window(attributes)?;
            let renderer = Renderer::new(Some(&window))?;
            let size = window.inner_size();
            let mut renderer = renderer;
            renderer.resize(size.width as usize, size.height as usize);
            hud::style(&self.egui);
            let input = egui_winit::State::new(
                self.egui.clone(),
                egui::ViewportId::ROOT,
                &window,
                Some(window.scale_factor() as f32),
                None,
                Some(8192),
            );
            self.game = Some(Game::open(&self.root, &self.world_name)?);
            self.game.as_mut().unwrap().ephemeral = self.window_benchmark.is_some() || self.ui_test;
            if self.window_benchmark.is_none() {
                self.game.as_mut().unwrap().interface.modal = space_native::ui_state::Modal::Help;
            }
            self.renderer = Some(renderer);
            self.input = Some(input);
            self.window = Some(window);
            Ok(())
        })();
        if let Err(error) = result {
            self.error = Some(error);
            event_loop.exit();
        }
    }
    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        let response = if let (Some(input), Some(window)) = (&mut self.input, &self.window) {
            input.on_window_event(window, &event).consumed
        } else {
            false
        };
        if let WindowEvent::Focused(focused) = &event
            && let Some(benchmark) = &mut self.window_benchmark
        {
            benchmark.focused = *focused;
        }
        match event {
            WindowEvent::Occluded(occluded) => {
                if let Some(benchmark) = &mut self.window_benchmark {
                    benchmark.occluded = occluded;
                }
            }
            WindowEvent::CloseRequested => {
                if let Some(game) = &mut self.game
                    && let Err(e) = game.apply_scripts().and_then(|_| game.save())
                {
                    game.status = format!(
                        "Save failed: {e:#}. The window remains open so your work can be recovered."
                    );
                    return;
                }
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                if let Some(renderer) = &mut self.renderer {
                    renderer.resize(size.width as usize, size.height as usize);
                }
            }
            WindowEvent::Focused(false) => {
                if let Some(game) = &mut self.game {
                    game.end_tool(true);
                }
                self.keys.clear();
                self.modifiers = ModifiersState::empty();
                self.capture(false);
            }
            WindowEvent::ModifiersChanged(state) => self.modifiers = state.state(),
            WindowEvent::CursorMoved { position, .. } => {
                let scale = self.egui.pixels_per_point() as f64;
                self.cursor = Some(egui::pos2(
                    (position.x / scale) as f32,
                    (position.y / scale) as f32,
                ));
            }
            WindowEvent::CursorLeft { .. } => self.cursor = None,
            WindowEvent::RedrawRequested => {
                if let Err(error) = objc2::rc::autoreleasepool(|_| self.draw(event_loop)) {
                    self.error = Some(error);
                    event_loop.exit();
                }
            }
            WindowEvent::DroppedFile(path) => {
                if let Some(game) = &mut self.game {
                    let r = game.import(&path);
                    game.result(r);
                }
            }
            WindowEvent::KeyboardInput { event, .. } => {
                if let PhysicalKey::Code(key) = event.physical_key {
                    if event.state == ElementState::Released {
                        self.keys.remove(&key);
                        return;
                    }
                    if key == KeyCode::Escape {
                        if let Some(game) = &mut self.game {
                            if game.interface.modal != space_native::ui_state::Modal::None {
                                if game.interface.modal == space_native::ui_state::Modal::ApiDocs {
                                    game.interface.modal = space_native::ui_state::Modal::Editor;
                                } else {
                                    game.close_modal();
                                }
                            } else if !game.interface.escape() {
                                game.end_tool(true);
                                game.selecting = false;
                            }
                        }
                        self.keys.clear();
                        self.capture(false);
                        return;
                    }
                    if key == KeyCode::F12 && !event.repeat {
                        if let Some(game) = &mut self.game {
                            game.capture = Some(self.root.join("results").join(if self.ui_test {
                                "ui-validation.png".to_owned()
                            } else {
                                format!("capture-{}.png", uuid::Uuid::new_v4())
                            }));
                        }
                        return;
                    }
                    if (self.modifiers.super_key() || self.modifiers.control_key())
                        && key == KeyCode::KeyQ
                    {
                        if let Some(game) = &mut self.game {
                            match game.apply_scripts().and_then(|_| game.save()) {
                                Ok(()) => event_loop.exit(),
                                Err(e) => game.status = e.to_string(),
                            }
                        }
                        return;
                    }
                    let editing_text = self.egui.memory(|m| m.focused()).is_some_and(|id| {
                        egui::text_edit::TextEditState::load(&self.egui, id).is_some()
                    });
                    if (self.modifiers.super_key() || self.modifiers.control_key())
                        && key == KeyCode::Enter
                    {
                        if let Some(game) = &mut self.game {
                            let r = game.apply_scripts();
                            game.result(r);
                        }
                        return;
                    }
                    if editing_text && !self.captured {
                        return;
                    }
                    if self
                        .game
                        .as_ref()
                        .is_some_and(|g| g.interface.modal != space_native::ui_state::Modal::None)
                    {
                        return;
                    }
                    if key == KeyCode::Enter && !event.repeat {
                        if let Some(game) = &mut self.game
                            && game.interface.placement.is_some()
                        {
                            let r = game.confirm_placement();
                            game.result(r);
                        } else if !response {
                            self.capture(!self.captured);
                        }
                        return;
                    }
                    if matches!(
                        key,
                        KeyCode::KeyW
                            | KeyCode::KeyA
                            | KeyCode::KeyS
                            | KeyCode::KeyD
                            | KeyCode::Space
                            | KeyCode::ShiftLeft
                            | KeyCode::ShiftRight
                    ) && let Some(game) = &mut self.game
                    {
                        game.interface.navigation_target = None;
                    }
                    self.keys.insert(key);
                    if event.repeat {
                        return;
                    }
                    if key == KeyCode::Space && self.captured {
                        if self
                            .last_jump
                            .is_some_and(|t| t.elapsed().as_secs_f32() < 0.35)
                        {
                            if let Some(game) = &mut self.game
                                && game.driver.is_none()
                            {
                                game.camera.flying = !game.camera.flying;
                                game.camera.velocity = DVec3::ZERO;
                            }
                            self.last_jump = None;
                        } else {
                            self.last_jump = Some(Instant::now());
                        }
                    }
                    let command = self.modifiers.super_key() || self.modifiers.control_key();
                    if let Some(game) = &mut self.game {
                        match key {
                            KeyCode::KeyG if !command && game.active_tool == HotbarTool::Select => {
                                game.dispatch(space_native::commands::Command::Assemble)
                            }
                            KeyCode::KeyC if !command => {
                                if let Some(pick) = game.pick_scene(self.renderer.as_ref().unwrap())
                                {
                                    game.interface.component = Some(pick.component.clone());
                                    game.open_entity_editor(Some((pick.entity, pick.hit.distance)));
                                } else {
                                    game.status = "Aim at an entity and press C to edit".into();
                                }
                            }
                            KeyCode::KeyF if !command && game.active_tool == HotbarTool::Select => {
                                game.dispatch(space_native::commands::Command::Fill)
                            }
                            KeyCode::KeyP if !command && game.active_tool == HotbarTool::Select => {
                                game.dispatch(space_native::commands::Command::Paint)
                            }
                            KeyCode::KeyI if !command => {
                                game.interface.color_picker = !game.interface.color_picker;
                                game.capture_request = Some(false);
                            }
                            KeyCode::KeyT if !command && game.active_tool == HotbarTool::Hammer => {
                                game.open_modal(space_native::ui_state::Modal::Text)
                            }
                            KeyCode::Digit1
                            | KeyCode::Digit2
                            | KeyCode::Digit3
                            | KeyCode::Digit4
                            | KeyCode::Digit5
                            | KeyCode::Digit6
                            | KeyCode::Digit7
                            | KeyCode::Digit8
                            | KeyCode::Digit9
                                if self.modifiers.alt_key() =>
                            {
                                let index = match key {
                                    KeyCode::Digit1 => 0,
                                    KeyCode::Digit2 => 1,
                                    KeyCode::Digit3 => 2,
                                    KeyCode::Digit4 => 3,
                                    KeyCode::Digit5 => 4,
                                    KeyCode::Digit6 => 5,
                                    KeyCode::Digit7 => 6,
                                    KeyCode::Digit8 => 7,
                                    _ => 8,
                                };
                                if game.active_tool == HotbarTool::Select && index < 5 {
                                    game.editor.selection_shape.shape =
                                        space_native::selection::Shape::ALL[index];
                                } else {
                                    game.interface.preferences.palette.selected = index;
                                    game.sync_palette();
                                }
                            }
                            KeyCode::Digit1
                            | KeyCode::Digit2
                            | KeyCode::Digit3
                            | KeyCode::Digit4
                            | KeyCode::Digit5
                            | KeyCode::Digit6
                            | KeyCode::Digit7
                            | KeyCode::Digit8
                            | KeyCode::Digit9
                                if self.modifiers.shift_key() =>
                            {
                                let slot = match key {
                                    KeyCode::Digit1 => 0,
                                    KeyCode::Digit2 => 1,
                                    KeyCode::Digit3 => 2,
                                    KeyCode::Digit4 => 3,
                                    KeyCode::Digit5 => 4,
                                    KeyCode::Digit6 => 5,
                                    KeyCode::Digit7 => 6,
                                    KeyCode::Digit8 => 7,
                                    _ => 8,
                                };
                                game.equip(space_native::backpack::Category::Items, slot);
                            }
                            KeyCode::Digit1 => game.choose_tool(HotbarTool::Select),
                            KeyCode::Digit2 => game.choose_tool(HotbarTool::Hammer),
                            KeyCode::Digit3 => game.choose_tool(HotbarTool::Wrench),
                            KeyCode::Digit4 => game.choose_tool(HotbarTool::Shovel),
                            KeyCode::Digit5 => game.choose_tool(HotbarTool::Spoon),
                            KeyCode::Digit6 => game.choose_tool(HotbarTool::Brush),
                            KeyCode::Digit7 => game.choose_tool(HotbarTool::Model),
                            KeyCode::KeyM | KeyCode::Tab if self.captured => game.toggle_grid(),
                            KeyCode::F5 | KeyCode::F3 => {
                                game.perspective = (game.perspective + 1) % 3
                            }
                            KeyCode::ArrowLeft
                            | KeyCode::ArrowRight
                            | KeyCode::ArrowUp
                            | KeyCode::ArrowDown => game.rotate_tool(
                                if matches!(key, KeyCode::ArrowUp | KeyCode::ArrowDown) {
                                    0
                                } else {
                                    1
                                },
                                if matches!(key, KeyCode::ArrowLeft | KeyCode::ArrowDown) {
                                    -1
                                } else {
                                    1
                                },
                            ),
                            KeyCode::KeyR if !command && game.active_tool == HotbarTool::Select => {
                                game.dispatch(space_native::commands::Command::Copy)
                            }
                            KeyCode::KeyX if !command && game.active_tool == HotbarTool::Select => {
                                game.dispatch(space_native::commands::Command::Cut)
                            }
                            KeyCode::KeyB | KeyCode::KeyE | KeyCode::KeyO => {
                                game.open_modal(if key == KeyCode::KeyO {
                                    space_native::ui_state::Modal::Settings
                                } else {
                                    space_native::ui_state::Modal::Backpack
                                })
                            }
                            KeyCode::KeyQ if command => {
                                if game.save().is_ok() {
                                    event_loop.exit();
                                }
                            }
                            KeyCode::KeyV if !command => {
                                let picked = game.pick_scene(self.renderer.as_ref().unwrap());
                                let r = game.toggle_seat(picked);
                                game.result(r);
                                self.keys.clear();
                            }
                            KeyCode::KeyR if !command && game.active_tool == HotbarTool::Model => {
                                let r = game.decoration_command(false);
                                game.result(r);
                            }
                            KeyCode::Delete | KeyCode::Backspace
                                if game.active_tool == HotbarTool::Model =>
                            {
                                let r = game.decoration_command(true);
                                game.result(r);
                            }
                            KeyCode::Delete | KeyCode::Backspace
                                if game.active_tool == HotbarTool::Select =>
                            {
                                game.dispatch(space_native::commands::Command::Erase)
                            }
                            KeyCode::KeyX if command => {
                                game.dispatch(space_native::commands::Command::Cut)
                            }
                            KeyCode::KeyZ if command => {
                                game.dispatch(if self.modifiers.shift_key() {
                                    space_native::commands::Command::Redo
                                } else {
                                    space_native::commands::Command::Undo
                                })
                            }
                            KeyCode::KeyC if command => {
                                game.dispatch(space_native::commands::Command::Copy)
                            }
                            KeyCode::KeyV if command => {
                                game.choose_tool(HotbarTool::Hammer);
                            }
                            KeyCode::KeyS if command => match game.save() {
                                Ok(()) => game.status = "Saved locally".into(),
                                Err(e) => game.status = format!("Save failed: {e:#}"),
                            },
                            KeyCode::Home => {
                                game.camera = Camera::overlooking(DVec3::from_array(
                                    game.world.source.manifest.spawn,
                                ))
                            }
                            KeyCode::F12 => {
                                game.capture = Some(
                                    self.root
                                        .join("results")
                                        .join(format!("capture-{}.png", uuid::Uuid::new_v4())),
                                )
                            }
                            _ => {}
                        }
                    }
                }
            }
            WindowEvent::MouseInput { state, button, .. } => {
                if state == ElementState::Released {
                    if let Some(game) = &mut self.game {
                        game.end_tool(false);
                    }
                    return;
                }
                if !self.captured {
                    // winit may deliver move + press before egui's next frame.
                    // Hit-test the current event position so a UI drag cannot
                    // accidentally capture the camera using last frame's hover.
                    let over_ui = response || pointer_over_ui(&self.egui, self.cursor);
                    if !over_ui
                        && button == MouseButton::Right
                        && let Some(game) = &mut self.game
                    {
                        game.interface.placement = None;
                    }
                    if !over_ui
                        && button == MouseButton::Left
                        && self.game.as_ref().is_some_and(|g| {
                            g.interface.modal == space_native::ui_state::Modal::None
                                && g.interface.context_menu.is_none()
                                && !g.interface.color_picker
                        })
                    {
                        self.capture(true);
                    }
                    return;
                }
                if matches!(button, MouseButton::Left | MouseButton::Right)
                    && let (Some(game), Some(renderer)) = (&mut self.game, &self.renderer)
                {
                    let pick = game.pick_scene(renderer);
                    if button == MouseButton::Left && game.click_running(pick.as_ref()) {
                        return;
                    }
                    let r = game.scene_press(
                        button == MouseButton::Right,
                        pick,
                        self.modifiers.shift_key(),
                    );
                    game.result(r);
                }
            }
            WindowEvent::MouseWheel { delta, .. } if self.captured => {
                let value = match delta {
                    MouseScrollDelta::LineDelta(_, y) => y as f64,
                    MouseScrollDelta::PixelDelta(p) => p.y / 40.0,
                };
                if let Some(game) = &mut self.game {
                    if let Some(grab) = &mut game.grab {
                        grab.distance = (grab.distance + value * 0.5).clamp(1.0, 50.0);
                    } else {
                        game.camera.speed =
                            (game.camera.speed * (value * 0.15).exp()).clamp(1.0, 200.0);
                    }
                }
            }
            _ => {}
        }
    }
    fn device_event(&mut self, _: &ActiveEventLoop, _: winit::event::DeviceId, event: DeviceEvent) {
        if self.captured
            && let DeviceEvent::MouseMotion { delta } = event
            && let Some(game) = &mut self.game
        {
            game.camera.look(delta.0, delta.1);
        }
    }
    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        event_loop.set_control_flow(ControlFlow::Poll);
        if let Some(window) = &self.window {
            window.request_redraw();
        }
    }
}

#[cfg(test)]
mod ui_input_tests {
    #[test]
    fn a_press_uses_current_cursor_before_the_next_ui_frame() {
        let ctx = egui::Context::default();
        for _ in 0..2 {
            let _ = ctx.run(
                egui::RawInput {
                    screen_rect: Some(egui::Rect::from_min_size(
                        egui::Pos2::ZERO,
                        egui::vec2(800.0, 600.0),
                    )),
                    ..Default::default()
                },
                |ctx| {
                    egui::Area::new("axis".into())
                        .fixed_pos([400.0, 300.0])
                        .show(ctx, |ui| {
                            ui.allocate_exact_size(egui::vec2(80.0, 12.0), egui::Sense::drag());
                        });
                },
            );
        }
        assert!(!ctx.wants_pointer_input());
        assert!(super::pointer_over_ui(&ctx, Some(egui::pos2(440.0, 306.0))));
        assert!(!super::pointer_over_ui(
            &ctx,
            Some(egui::pos2(100.0, 100.0))
        ));
        assert!(!super::pointer_over_ui(&ctx, None));
    }
}
