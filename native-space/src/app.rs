use crate::metal_renderer::{Renderer, Uniforms};
use space_native::{
    avatar::Avatar,
    interaction::{self, HotbarTool},
};
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
    editor::{Editor, SelectionAction, Tool},
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
    pending_world: Option<String>,
    active_tool: HotbarTool,
    panel_open: bool,
    capture_request: Option<bool>,
    selecting: bool,
    held_tool: Option<bool>,
    stroke_elapsed: f64,
    grab: Option<gameplay::Grab>,
    last_grab_click: Option<(String, Instant)>,
    preview_dirty: bool,
    preview_parts: Vec<(String, Mat4)>,
    avatar: Avatar,
    avatar_mode: Option<u8>,
    avatar_phase: f32,
    previous_position: DVec3,
    perspective: u8,
    model_size: [f32; 3],
}
#[derive(Clone, Copy, PartialEq)]
pub enum Panel {
    Build,
    Inventory,
    Entities,
    Settings,
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
        if save_path.exists() {
            let s = storage::load(&save_path, name, &source.manifest.source_hash)?;
            camera.position = DVec3::from_array(s.position);
            camera.yaw = s.yaw;
            camera.pitch = s.pitch;
            world.edits = s.edits.into_iter().collect();
            editor.entities = s.entities;
            editor.backpack = s.backpack;
            perspective = s.perspective.min(2);
        }
        let (mesh_tx, mesh_rx) = crossbeam_channel::bounded(8);
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(2)
            .thread_name(|i| format!("space-mesher-{i}"))
            .build()?;
        let runtime = Runtime::new(&source.root);
        Ok(Self {
            ephemeral: false,
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
            pending_world: None,
            active_tool: HotbarTool::Select,
            panel_open: false,
            capture_request: None,
            selecting: false,
            held_tool: None,
            stroke_elapsed: 0.0,
            grab: None,
            last_grab_click: None,
            preview_dirty: true,
            preview_parts: Vec::new(),
            avatar: Avatar::bundled()?,
            avatar_mode: None,
            avatar_phase: 0.0,
            perspective,
            model_size: [1.0; 3],
        })
    }
    pub fn save(&mut self) -> Result<()> {
        if self.ephemeral {
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
            backpack: self.editor.backpack.clone(),
            perspective: self.perspective,
        };
        storage::save(&self.save_path, &save)?;
        self.saved_revision = self.editor.revision;
        self.save_elapsed = 0.0;
        Ok(())
    }
    pub fn import(&mut self, path: &Path) -> Result<()> {
        let bytes = std::fs::read(path)?;
        let resource = protocol::decode(&bytes)?;
        self.editor.backpack.push(resource.clone());
        self.editor.clipboard = Some(resource);
        self.preview_dirty = true;
        self.editor.revision += 1;
        self.status = format!("Imported {}", path.display());
        Ok(())
    }
    pub fn export(&mut self) -> Result<()> {
        let resource = self
            .editor
            .selected_entity
            .and_then(|i| self.editor.entities.get(i))
            .map(|e| protocol::inventory::InventoryResource {
                schema_version: 8,
                content: Some(protocol::inventory::inventory_resource::Content::Entity(
                    e.definition.clone(),
                )),
            })
            .or_else(|| self.editor.clipboard.clone())
            .context("Select an entity or copy a selection to export")?;
        storage::atomic_write(Path::new(&self.path), &protocol::encode(&resource)?)?;
        self.status = format!("Exported {}", self.path);
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
                            let key = format!("entity:{}:{}", state.id, node.id);
                            let model = Mat4::from_cols_array(&node.model);
                            keep.insert(key.clone());
                            keep.insert(format!("{key}:alpha"));
                            if let Some(voxels) = &node.voxels {
                                renderer.upload(
                                    key.clone(),
                                    &runtime::voxel_faces(voxels),
                                    model,
                                )?;
                            }
                            renderer.set_model(&key, model);
                            for d in &node.decorations {
                                let key =
                                    format!("entity:{}:{}:decoration:{}", state.id, node.id, d.id);
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
                },
            ) {
                Ok(()) => self.simulation_elapsed = 0.0,
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
            clip: geometry::camera_matrix(
                eye,
                direction,
                size[0] as f32 / size[1].max(1) as f32,
                self.torus,
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
    fn paste_at_cursor(&mut self) -> Result<()> {
        let position = self.placement();
        self.editor.paste(&mut self.world, position)
    }
    fn build_ui(&mut self, ui: &mut egui::Ui) {
        ui.heading(self.active_tool.name());
        ui.label(self.active_tool.hint());
        if self.active_tool == HotbarTool::Model {
            ui.label("Decorative cube dimensions");
            for (i, axis) in ["X", "Y", "Z"].iter().enumerate() {
                ui.add(egui::Slider::new(&mut self.model_size[i], 0.125..=16.0).text(*axis));
            }
        }
        if self.active_tool == HotbarTool::Hammer {
            ui.label(self.editor.clipboard.as_ref().map_or(
                "Backpack is empty. Copy a selection or import an item.".into(),
                resource_name,
            ));
        }
        ui.checkbox(&mut self.editor.micro, "Micro grid · 0.125 m");
        ui.add(egui::Slider::new(&mut self.editor.brush, 1..=8).text("Brush"));
        let mut rgb = [
            (self.editor.rgb >> 16) as u8,
            (self.editor.rgb >> 8) as u8,
            self.editor.rgb as u8,
        ];
        ui.color_edit_button_srgb(&mut rgb);
        self.editor.rgb = ((rgb[0] as u32) << 16) | ((rgb[1] as u32) << 8) | rgb[2] as u32;
        ui.horizontal_wrapped(|ui| {
            for color in [
                0xf2a93b, 0x48dbfb, 0x2ed573, 0xeb4d4b, 0xa55eea, 0xf5f6fa, 0x2f3542, 0xff6b81,
                0xf1c40f,
            ] {
                if ui
                    .add(egui::Button::new("  ").fill(egui::Color32::from_rgb(
                        (color >> 16) as u8,
                        (color >> 8) as u8,
                        color as u8,
                    )))
                    .clicked()
                {
                    self.editor.rgb = color;
                }
            }
        });
        ui.add(egui::Slider::new(&mut self.editor.material, 0..=101).text("Material"));
        ui.small("0 solid · 1 emissive · 2–101 transparency");
        ui.separator();
        ui.horizontal(|ui| {
            if ui.button("Undo").clicked() {
                self.editor.undo(&mut self.world);
            }
            if ui.button("Redo").clicked() {
                self.editor.redo(&mut self.world);
            }
        });
        if let Some((a, b)) = self.editor.selection {
            ui.label(format!(
                "Selection: {},{},{} → {},{},{}",
                a.x, a.y, a.z, b.x, b.y, b.z
            ));
        }
        if ui.button("Start new selection").clicked() {
            self.editor.selection = None;
            self.choose_tool(HotbarTool::Select);
        }
        if ui.button("Copy selection").clicked() {
            self.preview_dirty = true;
            let r = self.editor.copy_selection(&self.world);
            self.result(r);
        }
        ui.horizontal(|ui| {
            if ui.button("Cut").clicked() {
                let r = self.editor.cut_selection(&mut self.world);
                self.result(r);
            }
            if ui.button("Delete").clicked() {
                let r = self
                    .editor
                    .change_selection(&mut self.world, SelectionAction::Erase);
                self.result(r);
            }
        });
        ui.horizontal(|ui| {
            if ui.button("Fill selection").clicked() {
                let r = self
                    .editor
                    .change_selection(&mut self.world, SelectionAction::Fill);
                self.result(r);
            }
            if ui.button("Paint selection").clicked() {
                let r = self
                    .editor
                    .change_selection(&mut self.world, SelectionAction::Paint);
                self.result(r);
            }
        });
        if ui.button("Rotate copied blocks 90°").clicked() {
            self.preview_dirty = true;
            let r = self.editor.rotate_clipboard();
            self.result(r);
        }
        if ui.button("Assemble selection  G").clicked()
            && let Err(error) = self.assemble_selection()
        {
            self.status = error.to_string();
        }
        if ui.button("Paste at crosshair  ⌘V").clicked() {
            let r = self.paste_at_cursor();
            self.result(r);
        }
        if ui.button("Store clipboard in backpack").clicked()
            && let Some(resource) = self.editor.clipboard.clone()
        {
            self.editor.backpack.push(resource);
            self.editor.revision += 1;
        }
        ui.separator();
        ui.label("Enter: play · Esc: controls\nWASD: move · Space/Q: up/down · Shift: boost\nF: fly/walk · F5: camera · B: backpack\n1–7: tools · Tab: grid · R: rotate\nG: assemble stopped · C: edit aimed entity");
    }
    fn inventory_ui(&mut self, ui: &mut egui::Ui) {
        ui.heading("Backpack");
        ui.label("Drop .edpb files into this window to import.");
        if ui.button("Load example entity").clicked() {
            let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples/entity.edpb");
            let r = self.import(&path);
            self.result(r);
        }
        ui.text_edit_singleline(&mut self.path);
        ui.horizontal(|ui| {
            if ui.button("Import file").clicked() {
                let path = PathBuf::from(&self.path);
                let r = self.import(&path);
                self.result(r);
            }
            if ui.button("Export clipboard").clicked() {
                let r = self.export();
                self.result(r);
            }
        });
        ui.separator();
        let mut action = None;
        for (i, resource) in self.editor.backpack.iter().enumerate() {
            let name = resource_name(resource);
            ui.horizontal(|ui| {
                if ui.button(format!("{} · {name}", i + 1)).clicked() {
                    action = Some((i, false));
                }
                if ui.small_button("×").clicked() {
                    action = Some((i, true));
                }
            });
        }
        if let Some((i, remove)) = action {
            if remove {
                self.editor.backpack.remove(i);
                self.editor.revision += 1;
            } else {
                self.editor.clipboard = Some(self.editor.backpack[i].clone());
                self.preview_dirty = true;
                self.choose_tool(HotbarTool::Hammer);
                self.status = "Item equipped. Enter the world and click to place.".into();
            }
        }
    }
    fn entities_ui(&mut self, ui: &mut egui::Ui) {
        if let Some(error) = &self.runtime_error {
            ui.colored_label(egui::Color32::LIGHT_RED, error);
            if ui.button("Restart simulation").clicked() {
                self.runtime = Runtime::new(&self.world.source.root);
                self.runtime_error = None;
                self.runtime_frame = None;
            }
        }
        ui.heading("Entities");
        for (i, e) in self.editor.entities.iter().enumerate() {
            if ui
                .selectable_label(self.editor.selected_entity == Some(i), e.name())
                .clicked()
            {
                self.editor.selected_entity = Some(i);
            }
        }
        if let Some(index) = self
            .editor
            .selected_entity
            .filter(|i| *i < self.editor.entities.len())
        {
            ui.separator();
            let mut changed = false;
            let e = &mut self.editor.entities[index];
            if ui
                .button(if e.running {
                    "Stop"
                } else {
                    "Run physics & scripts"
                })
                .clicked()
            {
                e.running = !e.running;
                changed = true;
            }
            if let Some(root) = &mut e.definition.root {
                changed |= ui.text_edit_singleline(&mut root.name).changed();
            }
            ui.label("Position");
            for (i, axis) in ["X", "Y", "Z"].iter().enumerate() {
                changed |= ui
                    .add(
                        egui::DragValue::new(&mut e.position[i])
                            .speed(0.125)
                            .prefix(format!("{axis} ")),
                    )
                    .changed();
            }
            if ui.button("Rotate 90° Y").clicked() {
                e.rotation = (glam::DQuat::from_rotation_y(std::f64::consts::FRAC_PI_2)
                    * glam::DQuat::from_array(e.rotation))
                .to_array();
                changed = true;
            }
            if let Some(root) = &mut e.definition.root {
                ui.push_id(&e.id, |ui| {
                    ui.collapsing("Component hierarchy", |ui| {
                        component_ui(ui, root, &mut changed)
                    });
                });
            }
            if changed {
                self.editor.revision += 1;
            }
            if let Some(state) = self.runtime_frame.as_ref().and_then(|f| {
                f.entities
                    .iter()
                    .find(|s| s.id == self.editor.entities[index].id)
            }) {
                ui.label(format!(
                    "Physics: {} · Script: {}",
                    if state.running { "running" } else { "stopped" },
                    state.status
                ));
                if let Some(error) = &state.error {
                    ui.colored_label(egui::Color32::LIGHT_RED, error);
                }
                for node in &state.nodes {
                    for seat in &node.seats {
                        if ui
                            .button(format!("Ride {} · seat {}", node.id, seat.index + 1))
                            .clicked()
                        {
                            self.driver = Some(Driver {
                                id: state.id.clone(),
                                component: node.id.clone(),
                                seat: seat.index,
                            });
                        }
                    }
                }
                ui.collapsing("Script console", |ui| {
                    for line in &state.logs {
                        ui.monospace(line);
                    }
                });
            }
            if self.driver.is_some() && ui.button("Dismount").clicked() {
                self.driver = None;
                self.camera.position += DVec3::new(2.0, 1.0, 0.0);
            }
            if ui.button("Duplicate").clicked() {
                let mut duplicate = self.editor.entities[index].clone();
                duplicate.id = uuid::Uuid::new_v4().to_string();
                duplicate.position[0] += 2.0;
                self.editor.entities.push(duplicate);
                self.editor.revision += 1;
            }
            if ui.button("Save to backpack").clicked() {
                self.editor
                    .backpack
                    .push(protocol::inventory::InventoryResource {
                        schema_version: 8,
                        content: Some(protocol::inventory::inventory_resource::Content::Entity(
                            self.editor.entities[index].definition.clone(),
                        )),
                    });
                self.editor.revision += 1;
            }
            if ui.button("Export entity").clicked() {
                let r = self.export();
                self.result(r);
            }
            if ui.button("Delete entity").clicked() {
                self.editor.entities.remove(index);
                self.editor.selected_entity = None;
                self.editor.revision += 1;
            }
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
fn resource_name(r: &protocol::inventory::InventoryResource) -> String {
    use protocol::inventory::inventory_resource::Content;
    match &r.content {
        Some(Content::BlockSet(b)) => b.name.clone(),
        Some(Content::Item(i)) => i.name.clone(),
        Some(Content::ColorSet(c)) => c.name.clone(),
        Some(Content::Entity(e)) => e.root.as_ref().map_or("Entity".into(), |c| c.name.clone()),
        None => "Invalid".into(),
    }
}
fn component_ui(ui: &mut egui::Ui, c: &mut protocol::inventory::Component, changed: &mut bool) {
    ui.push_id(&c.id, |ui| {
        ui.label(format!("{} · {} voxels", c.id, c.blocks.len()));
        *changed |= ui.text_edit_singleline(&mut c.name).changed();
        let mut body = c.body.unwrap_or_default();
        let mut body_changed = false;
        let mut body_type = body.r#type;
        ui.horizontal(|ui| {
            ui.selectable_value(&mut body_type, 0, "Dynamic")
                .on_hover_text("Simulated physics. Switching from kinematic enables gravity.");
            ui.selectable_value(&mut body_type, 1, "Kinematic")
                .on_hover_text("Moved by scripts; unaffected by gravity and forces.");
        });
        body_changed |= space_native::editor::set_body_type(&mut body, body_type);
        let mut gravity = body.use_gravity.unwrap_or(body.r#type == 0);
        if ui.checkbox(&mut gravity, "Gravity").changed() {
            body.use_gravity = Some(gravity);
            body_changed = true;
        }
        let mut collision = body.collision_enabled.unwrap_or(true);
        if ui.checkbox(&mut collision, "Collision").changed() {
            body.collision_enabled = Some(collision);
            body_changed = true;
        }
        let mut automatic_mass = body.mass.is_none();
        let volume: f64 = c
            .blocks
            .iter()
            .map(|b| if b.is_micro { 1.0 / 512.0 } else { 1.0 })
            .sum();
        let mut mass = body
            .mass
            .unwrap_or(((volume * 10_000.0).round() / 1000.0).max(0.1));
        if ui.checkbox(&mut automatic_mass, "Automatic mass").changed() {
            body.mass = if automatic_mass { None } else { Some(mass) };
            body_changed = true;
        }
        if ui
            .add_enabled(
                !automatic_mass,
                egui::DragValue::new(&mut mass)
                    .range(0.1..=1_000_000.0)
                    .prefix("Mass "),
            )
            .changed()
        {
            body.mass = Some(mass);
            body_changed = true;
        }
        let mut friction = body.friction.unwrap_or(0.7);
        if ui
            .add(egui::Slider::new(&mut friction, 0.0..=1.0).text("Friction"))
            .changed()
        {
            body.friction = Some(friction);
            body_changed = true;
        }
        if body_changed {
            c.body = Some(body);
            *changed = true;
        }
        if ui.button("Add seat at component origin").clicked() {
            c.seats.push(protocol::inventory::Seat {
                position: Some(Default::default()),
                ..Default::default()
            });
            *changed = true;
        }
        ui.collapsing("Script source", |ui| {
            let id = ui.id().with("script-draft");
            let mut draft = ui
                .data(|d| d.get_temp::<String>(id))
                .unwrap_or_else(|| c.script.clone().unwrap_or_default());
            ui.add(
                egui::TextEdit::multiline(&mut draft)
                    .code_editor()
                    .desired_rows(10),
            );
            if ui.button("Apply script").clicked() {
                c.script = Some(draft.clone());
                c.script_language = "assemblyscript".into();
                *changed = true;
            }
            ui.data_mut(|d| d.insert_temp(id, draft));
        });
        for child in &mut c.children {
            let name = child.name.clone();
            ui.collapsing(name, |ui| component_ui(ui, child, changed));
        }
    });
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
    captured: bool,
    last: Instant,
    frame_rate: space_native::frame_metrics::FrameRate,
    pub error: Option<anyhow::Error>,
    pub quit_after: Option<f64>,
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
            captured: false,
            last: Instant::now(),
            frame_rate: Default::default(),
            error: None,
            quit_after: None,
            window_benchmark: None,
            started: Instant::now(),
        }
    }
    fn capture(&mut self, value: bool) {
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
        game.stream(renderer)?;
        game.simulate(
            renderer,
            dt,
            if self.captured {
                self.keys.iter().map(|k| format!("{k:?}")).collect()
            } else {
                Vec::new()
            },
        )?;
        if self.captured && game.driver.is_none() {
            let pressed = |key| if self.keys.contains(&key) { 1.0 } else { 0.0 };
            game.camera.update(
                &game.world,
                DVec3::new(
                    pressed(KeyCode::KeyD) - pressed(KeyCode::KeyA),
                    pressed(KeyCode::Space) - pressed(KeyCode::KeyQ),
                    pressed(KeyCode::KeyW) - pressed(KeyCode::KeyS),
                ),
                self.modifiers.shift_key(),
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
                Ok(next) => {
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
            self.game.as_mut().unwrap().ephemeral = self.window_benchmark.is_some();
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
                    && let Err(e) = game.save()
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
                            game.end_tool(true);
                            game.selecting = false;
                        }
                        self.keys.clear();
                        self.capture(false);
                        return;
                    }
                    let editing_text = self.egui.memory(|m| m.focused()).is_some_and(|id| {
                        egui::text_edit::TextEditState::load(&self.egui, id).is_some()
                    });
                    if editing_text && !self.captured {
                        return;
                    }
                    if key == KeyCode::Enter && !response && !event.repeat {
                        self.capture(!self.captured);
                        return;
                    }
                    self.keys.insert(key);
                    if event.repeat {
                        return;
                    }
                    let command = self.modifiers.super_key() || self.modifiers.control_key();
                    if let Some(game) = &mut self.game {
                        match key {
                            KeyCode::KeyG if !command && game.active_tool == HotbarTool::Select => {
                                if let Err(error) = game.assemble_selection() {
                                    game.status = error.to_string();
                                }
                            }
                            KeyCode::KeyC if !command => {
                                let (eye, dir) = game.view();
                                let picked = self.renderer.as_ref().and_then(|r| {
                                    r.pick_entity(
                                        eye,
                                        dir,
                                        game.hit().map_or(50.0, |h| h.distance + 0.01),
                                    )
                                });
                                game.open_entity_editor(picked);
                            }
                            KeyCode::KeyF => game.camera.flying = !game.camera.flying,
                            KeyCode::Digit1 => game.choose_tool(HotbarTool::Select),
                            KeyCode::Digit2 => game.choose_tool(HotbarTool::Hammer),
                            KeyCode::Digit3 => game.choose_tool(HotbarTool::Wrench),
                            KeyCode::Digit4 => game.choose_tool(HotbarTool::Shovel),
                            KeyCode::Digit5 => game.choose_tool(HotbarTool::Spoon),
                            KeyCode::Digit6 => game.choose_tool(HotbarTool::Brush),
                            KeyCode::Digit7 => game.choose_tool(HotbarTool::Model),
                            KeyCode::KeyM | KeyCode::Tab if self.captured => {
                                game.editor.micro = !game.editor.micro
                            }
                            KeyCode::F5 | KeyCode::F3 => {
                                game.perspective = (game.perspective + 1) % 3
                            }
                            KeyCode::KeyR => game.rotate_tool(),
                            KeyCode::KeyB | KeyCode::KeyE | KeyCode::KeyO => {
                                game.end_tool(true);
                                game.panel_open = true;
                                game.panel = if key == KeyCode::KeyO {
                                    Panel::Settings
                                } else {
                                    Panel::Inventory
                                };
                                game.capture_request = Some(false);
                            }
                            KeyCode::KeyQ if command => {
                                if game.save().is_ok() {
                                    event_loop.exit();
                                }
                            }
                            KeyCode::KeyV if !command => {
                                if game.driver.take().is_some() {
                                    game.camera.position += DVec3::new(2.0, 1.0, 0.0);
                                } else if let Some(frame) = &game.runtime_frame {
                                    'seat: for e in &frame.entities {
                                        for n in &e.nodes {
                                            for seat in &n.seats {
                                                if DVec3::from_array(seat.position)
                                                    .distance(game.camera.position)
                                                    < 5.0
                                                {
                                                    game.driver = Some(Driver {
                                                        id: e.id.clone(),
                                                        component: n.id.clone(),
                                                        seat: seat.index,
                                                    });
                                                    break 'seat;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            KeyCode::Delete | KeyCode::Backspace
                                if game.active_tool == HotbarTool::Select =>
                            {
                                let r = game
                                    .editor
                                    .change_selection(&mut game.world, SelectionAction::Erase);
                                game.result(r);
                            }
                            KeyCode::KeyX if command => {
                                let r = game.editor.cut_selection(&mut game.world);
                                game.result(r);
                                game.preview_dirty = true;
                            }
                            KeyCode::KeyZ if command => {
                                game.end_tool(false);
                                if self.modifiers.shift_key() {
                                    game.editor.redo(&mut game.world);
                                } else {
                                    game.editor.undo(&mut game.world);
                                }
                            }
                            KeyCode::KeyC if command => {
                                game.preview_dirty = true;
                                let r = game.editor.copy_selection(&game.world);
                                game.result(r);
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
                    if !response && button == MouseButton::Left {
                        self.capture(true);
                    }
                    return;
                }
                if matches!(button, MouseButton::Left | MouseButton::Right)
                    && let (Some(game), Some(renderer)) = (&mut self.game, &self.renderer)
                {
                    let (eye, dir) = game.view();
                    let picked = if game.active_tool == HotbarTool::Wrench {
                        renderer.pick_entity(
                            eye,
                            dir,
                            game.hit().map_or(50.0, |h| h.distance + 0.01),
                        )
                    } else {
                        None
                    };
                    let r = game.tool_press(button == MouseButton::Right, picked);
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
