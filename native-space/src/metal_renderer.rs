use anyhow::{Context, Result, anyhow};
use bytemuck::{Pod, Zeroable};
use glam::{DVec3, Mat4, Vec3};
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_app_kit::NSView;
use objc2_foundation::{NSSize as CGSize, NSString};
use objc2_metal::*;
use objc2_quartz_core::{CAMetalDrawable, CAMetalLayer};
use rayon::prelude::*;
use space_native::geometry;
use space_native::geometry::{Face, PackedFace};
use space_native::visibility::{BLOCK_FACES, Coverage, CullView, VisibilityBlock, VisibilityTree};
use std::{
    collections::{HashMap, VecDeque},
    ffi::c_void,
    path::Path,
    ptr::NonNull,
};
use winit::{
    raw_window_handle::{HasWindowHandle, RawWindowHandle},
    window::Window,
};
#[path = "frame_validation.rs"]
mod frame_validation;

type Metal<T> = Retained<ProtocolObject<T>>;
const MAX_QUAD_GROUP: usize = 256;
#[derive(Default)]
pub struct FrameSamples {
    pub gpu: Vec<f64>,
    pub wall: Vec<f64>,
    pub cpu: Vec<f64>,
    pub allocations: usize,
    pub shadow_hits: usize,
}
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct Uniforms {
    pub clip: [[f32; 4]; 4],
    pub model: [[f32; 4]; 4],
    pub camera: [f32; 4],
    /// torus, lighting, exact lattice coordinates (set per draw), Ultra effects.
    pub options: [f32; 4],
}
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct UiVertex {
    pos: [f32; 2],
    uv: [f32; 2],
    color: u32,
}
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct FrameUniforms {
    inverse_direction_clip: [[f32; 4]; 4],
    correction: [[f32; 4]; 4],
    shadow: [[f32; 4]; 4],
    inverse_projection: [[f32; 4]; 4],
    eye: [f32; 4],
    up: [f32; 4],
    east: [f32; 4],
    north: [f32; 4],
    sun: [f32; 4],
    fill: [f32; 4],
    resolution: [f32; 4],
}
impl FrameUniforms {
    fn new(u: Uniforms, w: usize, h: usize, time: f32) -> Self {
        let camera = DVec3::new(u.camera[0] as f64, u.camera[1] as f64, u.camera[2] as f64);
        let torus = u.options[0] > 0.5;
        let basis = if torus {
            geometry::frame(camera).as_mat3()
        } else {
            glam::Mat3::IDENTITY
        };
        let eye = if torus {
            geometry::bend(camera).as_vec3()
        } else {
            camera.as_vec3()
        };
        let angle = (8.2_f32 - 6.0) / 24.0 * std::f32::consts::TAU;
        let sun = basis * Vec3::new(angle.cos(), angle.sin().max(0.1), 0.25).normalize();
        let clip = Mat4::from_cols_array_2d(&u.clip);
        let projection =
            Mat4::perspective_rh(70_f32.to_radians(), w as f32 / h as f32, 0.1, 10000.0);
        // Remove view translation BEFORE inversion. Unprojecting a distant
        // world point through a kilometre-scale f32 matrix and subtracting the
        // eye makes sky rays jump as the camera moves. Directions only need
        // rotation and projection; their homogeneous w is never divided out.
        let direction_clip = Mat4 {
            w_axis: projection.w_axis,
            ..clip
        };
        Self {
            inverse_direction_clip: direction_clip.inverse().to_cols_array_2d(),
            correction: Mat4::from_mat3(if torus {
                geometry::view_correction(camera).as_mat3()
            } else {
                glam::Mat3::IDENTITY
            })
            .to_cols_array_2d(),
            shadow: (Mat4::orthographic_rh(-64.0, 64.0, -64.0, 64.0, 0.5, 208.0)
                * Mat4::look_at_rh(eye + sun * 80.0, eye, basis.y_axis))
            .to_cols_array_2d(),
            inverse_projection: projection.inverse().to_cols_array_2d(),
            eye: eye.extend(1.0).to_array(),
            up: basis.y_axis.extend(0.0).to_array(),
            east: basis.x_axis.extend(0.0).to_array(),
            north: basis.z_axis.extend(0.0).to_array(),
            sun: sun.extend(0.0).to_array(),
            fill: (basis * Vec3::new(-0.6, 0.5, -0.65).normalize())
                .extend(0.0)
                .to_array(),
            resolution: [w as f32, h as f32, time, 0.0],
        }
    }
}
pub struct ReplayMesh {
    vertices: Metal<dyn MTLBuffer>,
    indices: Metal<dyn MTLBuffer>,
    count: usize,
    cull: bool,
}
struct Targets {
    depth: Metal<dyn MTLTexture>,
    ms_depth: Metal<dyn MTLTexture>,
    ms_color: Metal<dyn MTLTexture>,
    scene: Metal<dyn MTLTexture>,
    secondary: Metal<dyn MTLTexture>,
    atmosphere: Metal<dyn MTLTexture>,
    bright: Metal<dyn MTLTexture>,
    display: Metal<dyn MTLTexture>,
    bloom: Vec<(Metal<dyn MTLTexture>, Metal<dyn MTLTexture>)>,
}
pub struct Mesh {
    frame_visible: [bool; 2],
    frame_distance: f32,
    revision: u64,
    buffer: Metal<dyn MTLBuffer>,
    packed: bool,
    origin: Vec3,
    reference: Option<Metal<dyn MTLBuffer>>,
    blocks: Vec<VisibilityBlock>,
    tree: VisibilityTree,
    covered: Vec<u8>,
    coverage_revision: u64,
    maps: [VisibilityMap; 2],
    center: Vec3,
    bounds: Option<([f32; 4], bool)>,
    pub faces: usize,
    pub model: Mat4,
}
#[derive(Default)]
struct VisibilityMap {
    content_revision: u64,
    active: bool,
    offset: usize,
    dirty: bool,
    key: Option<VisibilityKey>,
    indices: Vec<u32>,
    scratch: Vec<u32>,
    buffer: Option<Metal<dyn MTLBuffer>>,
    faces: usize,
}
#[derive(Clone, PartialEq)]
struct VisibilityKey {
    inherit_proofs: bool,
    leaf_proofs: bool,
    clip: [[f32; 4]; 4],
    camera: [f32; 4],
    coverage: u64,
    torus: bool,
    hierarchical: bool,
}
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct DrawUniforms {
    origin: [f32; 4],
    counts: [u32; 4],
}
#[derive(Default)]
struct DynamicSlot {
    visibility: Option<Metal<dyn MTLBuffer>>,
    visibility_layout: Vec<(u64, usize, u64, usize, usize)>,
    ui: Option<Metal<dyn MTLBuffer>>,
}
#[derive(PartialEq)]
struct ShadowKey {
    quad_group: usize,
    camera: [f32; 4],
    shadow: [[f32; 4]; 4],
    correction: [[f32; 4]; 4],
    torus: bool,
    coverage: u64,
    draw_modes: [bool; 5],
    scene_revision: u64,
}
fn casts_shadow(key: &str) -> bool {
    !key.starts_with("avatar:hand") && !key.starts_with("preview:") && !key.ends_with(":alpha")
}
fn grow_buffer(
    device: &ProtocolObject<dyn MTLDevice>,
    buffer: &mut Option<Metal<dyn MTLBuffer>>,
    bytes: usize,
) -> Result<bool> {
    if bytes == 0 || buffer.as_ref().is_some_and(|b| b.length() >= bytes) {
        return Ok(false);
    }
    *buffer = Some(
        device
            .newBufferWithLength_options(
                bytes.next_power_of_two().max(4096),
                MTLResourceOptions::StorageModeShared,
            )
            .context("Grow dynamic frame buffer")?,
    );
    Ok(true)
}
/// Production defaults plus explicit A/B diagnostics. The freeze_* switches
/// only make sense with fixed camera, geometry and sky time.
#[derive(Clone, Copy)]
pub struct RenderProbe {
    pub inherit_cull_proofs: bool,
    pub leaf_cull_proofs: bool,
    pub quad_group: usize,
    pub cache_submission: bool,
    pub cache_shadows: bool,
    pub reuse_buffers: bool,
    pub memoryless_msaa: bool,
    pub grouped_quads: bool,
    pub compact_faces: bool,
    pub fine_culling: bool,
    pub hierarchical_culling: bool,
    pub validate_visibility: bool,
    pub freeze_shadow: bool,
    pub freeze_secondary: bool,
    pub freeze_bloom: bool,
    pub skip_post: bool,
    pub skip_far: bool,
}
impl Default for RenderProbe {
    fn default() -> Self {
        Self {
            inherit_cull_proofs: true,
            leaf_cull_proofs: true,
            quad_group: 32,
            cache_submission: true,
            cache_shadows: true,
            reuse_buffers: true,
            memoryless_msaa: true,
            grouped_quads: true,
            compact_faces: true,
            fine_culling: true,
            hierarchical_culling: true,
            validate_visibility: false,
            freeze_shadow: false,
            freeze_secondary: false,
            freeze_bloom: false,
            skip_post: false,
            skip_far: false,
        }
    }
}
impl RenderProbe {
    pub fn legacy() -> Self {
        Self {
            inherit_cull_proofs: false,
            cache_submission: false,
            cache_shadows: false,
            reuse_buffers: false,
            memoryless_msaa: false,
            grouped_quads: false,
            compact_faces: false,
            fine_culling: false,
            ..Self::default()
        }
    }
}
pub struct Renderer {
    geometry_revision: u64,
    shadow_revision: u64,
    shadow_key: Option<ShadowKey>,
    dynamic_slots: [DynamicSlot; 3],
    dynamic_slot: usize,
    targets_memoryless: bool,
    pub shadow_cache_hit: bool,
    pub dynamic_allocations: usize,
    pub benchmark_allocations: usize,
    pub benchmark_shadow_hits: usize,
    pub probe: RenderProbe,
    pub shadow_faces: usize,
    pub shadow_draws: usize,
    pub device: Metal<dyn MTLDevice>,
    quad_indices: Metal<dyn MTLBuffer>,
    theta_table: Metal<dyn MTLBuffer>,
    phi_table: Metal<dyn MTLBuffer>,
    queue: Metal<dyn MTLCommandQueue>,
    pub layer: Option<Retained<CAMetalLayer>>,
    pipeline: Metal<dyn MTLRenderPipelineState>,
    transparent_pipeline: Metal<dyn MTLRenderPipelineState>,
    ui_pipeline: Metal<dyn MTLRenderPipelineState>,
    depth_state: Metal<dyn MTLDepthStencilState>,
    transparent_depth: Metal<dyn MTLDepthStencilState>,
    ui_depth: Metal<dyn MTLDepthStencilState>,
    targets: Option<Targets>,
    shadow_map: Metal<dyn MTLTexture>,
    mask: Metal<dyn MTLTexture>,
    coverage: Coverage,
    visibility_pool: rayon::ThreadPool,
    shadow_pipeline: Metal<dyn MTLRenderPipelineState>,
    replay_pipeline: Metal<dyn MTLRenderPipelineState>,
    replay_shadow_pipeline: Metal<dyn MTLRenderPipelineState>,
    sky_pipeline: Metal<dyn MTLRenderPipelineState>,
    baseline: Vec<Metal<dyn MTLRenderPipelineState>>,
    targets_ultra: bool,
    post: HashMap<&'static str, Metal<dyn MTLRenderPipelineState>>,
    replay: Vec<ReplayMesh>,
    reference_pipelines: Option<Vec<Metal<dyn MTLRenderPipelineState>>>,
    started: std::time::Instant,
    pub animate_sky: bool,
    depth_size: [usize; 2],
    textures: HashMap<egui::TextureId, Metal<dyn MTLTexture>>,
    sampler: Metal<dyn MTLSamplerState>,
    meshes: HashMap<String, Mesh>,
    inflight: VecDeque<Metal<dyn MTLCommandBuffer>>,
    pub gpu_ms: f64,
    pub draw_calls: usize,
    pub visible_faces: usize,
}
fn ptr<T>(data: &[T]) -> NonNull<c_void> {
    NonNull::new(data.as_ptr().cast_mut().cast()).unwrap()
}
fn uses_visibility(mesh: &Mesh, u: Uniforms) -> bool {
    !mesh.blocks.is_empty()
        && mesh.model == Mat4::IDENTITY
        && mesh
            .bounds
            .is_some_and(|(_, torus)| torus == (u.options[0] > 0.5))
}
fn mesh_distance(mesh: &Mesh, camera: Vec3) -> f32 {
    let mut delta = mesh.model.transform_point3(mesh.center) - camera;
    delta.x -= (delta.x / 16384.0).round() * 16384.0;
    delta.z -= (delta.z / 2048.0).round() * 2048.0;
    delta.length_squared()
}
fn mesh_visible(
    mesh: &Mesh,
    uniforms: Uniforms,
    frame: &FrameUniforms,
    shadow: bool,
    frustum: Option<&geometry::Frustum>,
) -> bool {
    let Some((bound, torus)) = mesh.bounds else {
        return true;
    };
    if torus != (uniforms.options[0] > 0.5) {
        return true;
    }
    let mut center = Vec3::new(bound[0], bound[1], bound[2]);
    let mut radius = bound[3];
    let eye = Vec3::new(frame.eye[0], frame.eye[1], frame.eye[2]);
    if torus && center.distance(eye) - radius < 256.0 {
        let delta = center - eye;
        let t = ((delta.length() - 96.0) / 160.0).clamp(0.0, 1.0);
        center += (Mat4::from_cols_array_2d(&frame.correction).transform_vector3(delta) - delta)
            * (1.0 - t * t * (3.0 - 2.0 * t));
        radius *= 4.0;
    }
    if let Some(frustum) = frustum {
        return frustum.contains_sphere(center, radius);
    }
    geometry::sphere_in_frustum(
        Mat4::from_cols_array_2d(if shadow {
            &frame.shadow
        } else {
            &uniforms.clip
        }),
        center,
        radius,
    )
}
impl Renderer {
    pub fn new(window: Option<&Window>) -> Result<Self> {
        let device = MTLCreateSystemDefaultDevice().context("Metal device unavailable")?;
        let queue = device
            .newCommandQueue()
            .context("Create Metal command queue")?;
        let source = NSString::from_str(include_str!("../shaders/space.metal"));
        let library = device
            .newLibraryWithSource_options_error(&source, None)
            .map_err(|e| anyhow!("Metal shader: {e}"))?;
        anyhow::ensure!(
            device.supportsTextureSampleCount(4),
            "4x MSAA is required for Ultra"
        );
        let hdr = MTLPixelFormat::RGBA16Float;
        let display = MTLPixelFormat::BGRA8Unorm_sRGB;
        let pipeline = make_pipeline(
            &device,
            &library,
            "voxel_vertex",
            "voxel_fragment",
            false,
            hdr,
            4,
            true,
        )?;
        let transparent_pipeline = make_pipeline(
            &device,
            &library,
            "voxel_vertex",
            "voxel_fragment",
            true,
            hdr,
            4,
            true,
        )?;
        let ui_pipeline = make_pipeline(
            &device,
            &library,
            "ui_vertex",
            "ui_fragment",
            true,
            display,
            1,
            false,
        )?;
        let replay_pipeline = make_pipeline(
            &device,
            &library,
            "replay_vertex",
            "voxel_fragment",
            false,
            hdr,
            4,
            true,
        )?;
        let shadow_pipeline = make_pipeline(
            &device,
            &library,
            "shadow_vertex",
            "replay_shadow_fragment",
            false,
            MTLPixelFormat::Invalid,
            1,
            true,
        )?;
        let replay_shadow_pipeline = make_pipeline(
            &device,
            &library,
            "replay_shadow_vertex",
            "replay_shadow_fragment",
            false,
            MTLPixelFormat::Invalid,
            1,
            true,
        )?;
        let sky_pipeline = make_pipeline(
            &device,
            &library,
            "fullscreen",
            "sky_fragment",
            false,
            hdr,
            4,
            true,
        )?;
        let baseline = vec![
            make_pipeline(
                &device,
                &library,
                "voxel_vertex",
                "voxel_fragment",
                false,
                display,
                4,
                true,
            )?,
            make_pipeline(
                &device,
                &library,
                "voxel_vertex",
                "voxel_fragment",
                true,
                display,
                4,
                true,
            )?,
            make_pipeline(
                &device,
                &library,
                "replay_vertex",
                "voxel_fragment",
                false,
                display,
                4,
                true,
            )?,
            make_pipeline(
                &device,
                &library,
                "fullscreen",
                "sky_fragment",
                false,
                display,
                4,
                true,
            )?,
        ];
        let mut post = HashMap::new();
        for name in [
            "secondary_fragment",
            "atmosphere_fragment",
            "bloom_extract",
            "bloom_blur",
            "output_fragment",
            "copy_fragment",
            "fxaa_fragment",
        ] {
            let format = if name == "output_fragment"
                || name == "copy_fragment"
                || name == "fxaa_fragment"
            {
                display
            } else {
                hdr
            };
            post.insert(
                name,
                make_pipeline(
                    &device,
                    &library,
                    "fullscreen",
                    name,
                    false,
                    format,
                    1,
                    false,
                )?,
            );
        }
        let shadow_map = texture(&device, 4096, 4096, MTLPixelFormat::Depth32Float, 1)?;
        let mask = texture(&device, 1, 1, MTLPixelFormat::RG8Unorm, 1)?;
        let d = MTLDepthStencilDescriptor::new();
        d.setDepthCompareFunction(MTLCompareFunction::LessEqual);
        d.setDepthWriteEnabled(true);
        let depth_state = device
            .newDepthStencilStateWithDescriptor(&d)
            .context("Create depth state")?;
        d.setDepthWriteEnabled(false);
        let transparent_depth = device.newDepthStencilStateWithDescriptor(&d).unwrap();
        d.setDepthCompareFunction(MTLCompareFunction::Always);
        let ui_depth = device.newDepthStencilStateWithDescriptor(&d).unwrap();
        let sampler_desc = MTLSamplerDescriptor::new();
        sampler_desc.setMinFilter(MTLSamplerMinMagFilter::Linear);
        sampler_desc.setMagFilter(MTLSamplerMinMagFilter::Linear);
        let sampler = device
            .newSamplerStateWithDescriptor(&sampler_desc)
            .context("Create sampler")?;
        let layer = if let Some(window) = window {
            let layer = CAMetalLayer::new();
            layer.setDevice(Some(&device));
            layer.setPixelFormat(MTLPixelFormat::BGRA8Unorm_sRGB);
            layer.setFramebufferOnly(false);
            layer.setDisplaySyncEnabled(true);
            layer.setContentsScale(window.scale_factor());
            let RawWindowHandle::AppKit(handle) = window.window_handle()?.as_raw() else {
                anyhow::bail!("Expected AppKit window");
            };
            // Winit owns the NSView and this call is on its main event thread.
            let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
            view.setWantsLayer(true);
            view.setLayer(Some(&layer));
            Some(layer)
        } else {
            None
        };
        let theta: Vec<[f32; 2]> = (0..131072)
            .map(|i| {
                let angle = i as f64 / 131072.0 * std::f64::consts::TAU;
                [angle.cos() as f32, angle.sin() as f32]
            })
            .collect();
        let phi: Vec<[f32; 2]> = (0..16384)
            .map(|i| {
                let t = i as f64 / 16384.0 * std::f64::consts::TAU;
                let angle = 2.0 * ((9.0_f64 / 7.0).sqrt() * (t / 2.0).sin()).atan2((t / 2.0).cos());
                [angle.cos() as f32, angle.sin() as f32]
            })
            .collect();
        let buffer = |bytes: &[u8]| {
            unsafe {
                device.newBufferWithBytes_length_options(
                    ptr(bytes),
                    bytes.len(),
                    MTLResourceOptions::StorageModeShared,
                )
            }
            .context("Allocate immutable geometry table")
        };
        let indices: Vec<u16> = (0..MAX_QUAD_GROUP as u16)
            .flat_map(|i| [0, 1, 2, 2, 1, 3].map(|v| v + i * 4))
            .collect();
        let quad_indices = buffer(bytemuck::cast_slice(&indices))?;
        let theta_table = buffer(bytemuck::cast_slice(&theta))?;
        let phi_table = buffer(bytemuck::cast_slice(&phi))?;
        Ok(Self {
            geometry_revision: 0,
            shadow_revision: 0,
            shadow_key: None,
            dynamic_slots: Default::default(),
            dynamic_slot: 0,
            targets_memoryless: false,
            shadow_cache_hit: false,
            dynamic_allocations: 0,
            benchmark_allocations: 0,
            benchmark_shadow_hits: 0,
            probe: RenderProbe::default(),
            shadow_faces: 0,
            shadow_draws: 0,
            device,
            quad_indices,
            theta_table,
            phi_table,
            queue,
            layer,
            pipeline,
            transparent_pipeline,
            ui_pipeline,
            depth_state,
            transparent_depth,
            ui_depth,
            targets: None,
            shadow_map,
            mask,
            coverage: Coverage::default(),
            visibility_pool: rayon::ThreadPoolBuilder::new()
                .num_threads(4)
                .thread_name(|i| format!("space-culler-{i}"))
                .build()?,
            shadow_pipeline,
            replay_pipeline,
            replay_shadow_pipeline,
            sky_pipeline,
            baseline,
            targets_ultra: true,
            post,
            replay: Vec::new(),
            reference_pipelines: None,
            started: std::time::Instant::now(),
            animate_sky: true,
            depth_size: [0, 0],
            textures: HashMap::new(),
            sampler,
            meshes: HashMap::new(),
            inflight: VecDeque::new(),
            gpu_ms: 0.0,
            draw_calls: 0,
            visible_faces: 0,
        })
    }
    fn buffer(&self, data: &[u8]) -> Result<Metal<dyn MTLBuffer>> {
        // Metal copies the input; command buffers retain buffers through GPU completion.
        unsafe {
            self.device.newBufferWithBytes_length_options(
                ptr(data),
                data.len(),
                MTLResourceOptions::StorageModeShared,
            )
        }
        .context("Allocate Metal buffer")
    }
    pub fn upload(&mut self, key: String, faces: &[Face], model: Mat4) -> Result<()> {
        self.remove(&key);
        let (opaque, alpha): (Vec<_>, Vec<_>) =
            faces.iter().copied().partition(|f| (f.color >> 24) <= 2);
        for (name, data) in [(key.clone(), opaque), (key + ":alpha", alpha)] {
            if !data.is_empty() {
                self.geometry_revision += 1;
                if casts_shadow(&name) {
                    self.shadow_revision += 1;
                }
                let origin = data.iter().fold(Vec3::splat(f32::INFINITY), |a, f| {
                    a.min(Vec3::from_array(f.origin))
                });
                let packed: Option<Vec<PackedFace>> =
                    data.iter().map(|f| PackedFace::pack(*f, origin)).collect();
                let buffer = self.buffer(
                    packed
                        .as_ref()
                        .map(|v| bytemuck::cast_slice(v))
                        .unwrap_or(bytemuck::cast_slice(&data)),
                )?;
                self.meshes.insert(
                    name,
                    Mesh {
                        frame_visible: [true; 2],
                        frame_distance: 0.0,
                        revision: self.geometry_revision,
                        buffer,
                        packed: packed.is_some(),
                        origin,
                        reference: None,
                        blocks: Vec::new(),
                        tree: VisibilityTree::default(),
                        covered: Vec::new(),
                        coverage_revision: 0,
                        maps: Default::default(),
                        bounds: None,
                        center: {
                            let mut min = Vec3::splat(f32::INFINITY);
                            let mut max = Vec3::splat(f32::NEG_INFINITY);
                            for f in &data {
                                let p = Vec3::from_array(f.origin);
                                let mut q = p;
                                let axis = f.axis as usize / 2;
                                q[(axis + 1) % 3] += f.extent[0];
                                q[(axis + 2) % 3] += f.extent[1];
                                min = min.min(p);
                                max = max.max(q);
                            }
                            (min + max) * 0.5
                        },
                        faces: data.len(),
                        model,
                    },
                );
            }
        }
        Ok(())
    }
    pub fn upload_distant(
        &mut self,
        tile: &space_native::distant::Tile,
        torus: bool,
    ) -> Result<()> {
        if tile.data.is_empty() {
            self.remove(&tile.key);
            return Ok(());
        }
        let origin = Vec3::from_array(tile.origin);
        let mut min = Vec3::splat(f32::INFINITY);
        let mut max = Vec3::splat(f32::NEG_INFINITY);
        for f in &tile.data {
            let f = f.unpack(origin);
            let p = Vec3::from_array(f.origin);
            let mut q = p;
            let axis = f.axis as usize / 2;
            q[(axis + 1) % 3] += f.extent[0];
            q[(axis + 2) % 3] += f.extent[1];
            min = min.min(p);
            max = max.max(q);
        }
        self.geometry_revision += 1;
        if casts_shadow(&tile.key) {
            self.shadow_revision += 1;
        }
        let mesh = Mesh {
            frame_visible: [true; 2],
            frame_distance: 0.0,
            revision: self.geometry_revision,
            buffer: self.buffer(bytemuck::cast_slice(&tile.data))?,
            packed: true,
            origin,
            reference: None,
            tree: VisibilityTree::new(&tile.visibility),
            blocks: tile.visibility.clone(),
            covered: Vec::new(),
            coverage_revision: 0,
            maps: Default::default(),
            center: (min + max) * 0.5,
            bounds: Some((tile.bounds, torus)),
            faces: tile.faces,
            model: Mat4::IDENTITY,
        };
        self.meshes.insert(tile.key.clone(), mesh);
        Ok(())
    }
    pub fn frame_size(&self) -> [usize; 2] {
        self.depth_size
    }
    pub fn frame_height(&self) -> u32 {
        self.depth_size[1] as u32
    }
    pub fn remove(&mut self, key: &str) {
        if self.meshes.remove(key).is_some() && casts_shadow(key) {
            self.shadow_revision += 1;
        }
        self.meshes.remove(&format!("{key}:alpha"));
    }
    pub fn retain_meshes(&mut self, mut keep: impl FnMut(&str) -> bool) {
        let mut changed = false;
        self.meshes.retain(|key, _| {
            let retain = keep(key);
            changed |= !retain && casts_shadow(key);
            retain
        });
        if changed {
            self.shadow_revision += 1;
        }
    }
    pub fn resident_faces(&self) -> usize {
        self.meshes.values().map(|m| m.faces).sum()
    }
    pub fn has_mesh(&self, key: &str) -> bool {
        self.meshes.contains_key(key) || self.meshes.contains_key(&format!("{key}:alpha"))
    }
    /// Pick the actual displayed entity faces, including runtime component poses.
    pub fn pick_entity(&self, eye: DVec3, direction: DVec3, limit: f64) -> Option<(String, f64)> {
        let mut nearest = limit;
        let mut result = None;
        for (key, mesh) in &self.meshes {
            if !key.starts_with("entity:") {
                continue;
            }
            let inverse = mesh.model.as_dmat4().inverse();
            let eye = inverse.transform_point3(eye);
            let ray = inverse.transform_vector3(direction);
            for i in 0..mesh.faces {
                let face = unsafe {
                    if mesh.packed {
                        mesh.buffer
                            .contents()
                            .as_ptr()
                            .cast::<PackedFace>()
                            .add(i)
                            .read()
                            .unpack(mesh.origin)
                    } else {
                        mesh.buffer.contents().as_ptr().cast::<Face>().add(i).read()
                    }
                };
                let axis = face.axis as usize / 2;
                if ray[axis].abs() < 1e-9 || face.color >> 24 == 102 {
                    continue;
                }
                let origin = Vec3::from_array(face.origin).as_dvec3();
                let distance = (origin[axis] - eye[axis]) / ray[axis];
                if distance < 0.0 || distance > nearest {
                    continue;
                }
                let hit = eye + ray * distance - origin;
                if hit[(axis + 1) % 3] >= -1e-6
                    && hit[(axis + 1) % 3] <= face.extent[0] as f64 + 1e-6
                    && hit[(axis + 2) % 3] >= -1e-6
                    && hit[(axis + 2) % 3] <= face.extent[1] as f64 + 1e-6
                {
                    nearest = distance;
                    result = key.split(':').nth(1).map(|id| (id.to_owned(), distance));
                }
            }
        }
        result
    }
    pub fn set_model(&mut self, key: &str, model: Mat4) {
        for name in [key.to_owned(), format!("{key}:alpha")] {
            if let Some(mesh) = self.meshes.get_mut(&name) {
                if mesh.model != model && casts_shadow(&name) {
                    self.shadow_revision += 1;
                }
                mesh.model = model;
            }
        }
    }
    pub fn resize(&mut self, w: usize, h: usize) {
        if let Some(layer) = &self.layer {
            layer.setDrawableSize(CGSize::new(w as f64, h as f64));
        }
    }
    pub fn set_vsync(&self, value: bool) {
        if let Some(layer) = &self.layer {
            layer.setDisplaySyncEnabled(value);
        }
    }
    pub fn offscreen_texture(&self, width: usize, height: usize) -> Result<Metal<dyn MTLTexture>> {
        let d = unsafe {
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                MTLPixelFormat::BGRA8Unorm_sRGB,
                width,
                height,
                false,
            )
        };
        d.setUsage(MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead);
        d.setStorageMode(MTLStorageMode::Shared);
        self.device
            .newTextureWithDescriptor(&d)
            .context("Allocate offscreen target")
    }
    pub fn update_textures(&mut self, delta: &egui::TexturesDelta) -> Result<()> {
        // Texture updates are infrequent. Wait before mutating an atlas used by older frames.
        if !delta.set.is_empty() {
            self.finish()?;
        }
        for (id, change) in &delta.set {
            let egui::ImageData::Color(image) = &change.image;
            let [w, h] = image.size;
            if change.pos.is_none() {
                let d = unsafe {
                    MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                        MTLPixelFormat::RGBA8Unorm,
                        w,
                        h,
                        false,
                    )
                };
                d.setUsage(MTLTextureUsage::ShaderRead);
                d.setStorageMode(MTLStorageMode::Shared);
                self.textures.insert(
                    *id,
                    self.device
                        .newTextureWithDescriptor(&d)
                        .context("Allocate UI texture")?,
                );
            }
            let texture = self.textures.get(id).context("Missing UI atlas")?;
            let [x, y] = change.pos.unwrap_or([0, 0]);
            let data: Vec<u8> = image.pixels.iter().flat_map(|p| p.to_array()).collect();
            unsafe {
                texture.replaceRegion_mipmapLevel_withBytes_bytesPerRow(
                    MTLRegion {
                        origin: MTLOrigin { x, y, z: 0 },
                        size: MTLSize {
                            width: w,
                            height: h,
                            depth: 1,
                        },
                    },
                    0,
                    ptr(&data),
                    w * 4,
                );
            }
        }
        Ok(())
    }
    fn ensure_depth(&mut self, w: usize, h: usize, ultra: bool) -> Result<()> {
        let memoryless =
            self.probe.memoryless_msaa && self.device.supportsFamily(MTLGPUFamily::Apple1);
        if self.depth_size != [w, h]
            || self.targets_ultra != ultra
            || self.targets_memoryless != memoryless
        {
            self.finish()?;
            let hdr = MTLPixelFormat::RGBA16Float;
            let depth = MTLPixelFormat::Depth32Float;
            let t = |w, h, format, samples| {
                texture_with_storage(
                    &self.device,
                    w,
                    h,
                    format,
                    samples,
                    memoryless && samples > 1,
                )
            };
            let mut bloom = Vec::new();
            for i in 0..5 {
                let bw = (w >> (i + 1)).max(1);
                let bh = (h >> (i + 1)).max(1);
                bloom.push((t(bw, bh, hdr, 1)?, t(bw, bh, hdr, 1)?));
            }
            self.targets = Some(Targets {
                depth: t(w, h, depth, 1)?,
                ms_depth: t(w, h, depth, 4)?,
                ms_color: t(
                    w,
                    h,
                    if ultra {
                        hdr
                    } else {
                        MTLPixelFormat::BGRA8Unorm_sRGB
                    },
                    4,
                )?,
                scene: t(w, h, hdr, 1)?,
                display: t(w, h, MTLPixelFormat::BGRA8Unorm_sRGB, 1)?,
                secondary: t(w.div_ceil(2), h.div_ceil(2), hdr, 1)?,
                atmosphere: t(w, h, hdr, 1)?,
                bright: t((w / 2).max(1), (h / 2).max(1), hdr, 1)?,
                bloom,
            });
            self.depth_size = [w, h];
            self.targets_ultra = ultra;
            self.targets_memoryless = memoryless;
        }
        Ok(())
    }
    pub fn upload_replay(&mut self, vertices: &[u8], indices: &[u8], cull: bool) -> Result<()> {
        self.geometry_revision += 1;
        self.shadow_revision += 1;
        self.replay.push(ReplayMesh {
            vertices: self.buffer(vertices)?,
            indices: self.buffer(indices)?,
            count: indices.len() / 4,
            cull,
        });
        Ok(())
    }
    pub fn upload_mask(&mut self, bytes: &[u8]) -> Result<()> {
        anyhow::ensure!(bytes.len() == 1024 * 128 * 2, "Invalid handoff mask");
        self.coverage.update(bytes);
        let d = unsafe {
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                MTLPixelFormat::RG8Unorm,
                1024,
                128,
                false,
            )
        };
        d.setUsage(MTLTextureUsage::ShaderRead);
        d.setStorageMode(MTLStorageMode::Shared);
        self.mask = self
            .device
            .newTextureWithDescriptor(&d)
            .context("Allocate handoff mask")?;
        unsafe {
            self.mask.replaceRegion_mipmapLevel_withBytes_bytesPerRow(
                MTLRegion {
                    origin: MTLOrigin { x: 0, y: 0, z: 0 },
                    size: MTLSize {
                        width: 1024,
                        height: 128,
                        depth: 1,
                    },
                },
                0,
                ptr(bytes),
                2048,
            );
        }
        Ok(())
    }
    /// Reuses targets and resident geometry; excludes PNG/readback and warmup.
    pub fn benchmark(
        &mut self,
        u: Uniforms,
        size: [usize; 2],
        warmup: usize,
        frames: usize,
    ) -> Result<(Vec<f64>, Vec<f64>)> {
        let target = self.offscreen_texture(size[0], size[1])?;
        let mut gpu = Vec::new();
        let mut wall = Vec::new();
        self.benchmark_allocations = 0;
        self.benchmark_shadow_hits = 0;
        self.animate_sky = false;
        for i in 0..warmup + frames {
            let start = std::time::Instant::now();
            let command = self.encode(&target, u, &[], 1.0)?;
            command.commit();
            self.inflight.push_back(command);
            self.finish()?;
            if i >= warmup {
                self.benchmark_allocations += self.dynamic_allocations;
                self.benchmark_shadow_hits += usize::from(self.shadow_cache_hit);
                gpu.push(self.gpu_ms);
                wall.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        Ok((gpu, wall))
    }
    pub fn benchmark_path(
        &mut self,
        path: &[Uniforms],
        size: [usize; 2],
    ) -> Result<(Vec<f64>, Vec<f64>, Vec<f64>)> {
        self.benchmark_paint_path(path, size, &[])
    }
    /// Short paired batches reduce time-order bias from other desktop work.
    /// Warm each variant after switching, so caches retain production semantics.
    pub fn benchmark_pair(
        &mut self,
        path: &[Uniforms],
        size: [usize; 2],
        paint: &[egui::ClippedPrimitive],
        variants: [RenderProbe; 2],
    ) -> Result<[FrameSamples; 2]> {
        anyhow::ensure!(!path.is_empty(), "Empty benchmark path");
        let target = self.offscreen_texture(size[0], size[1])?;
        let mut samples: [FrameSamples; 2] = Default::default();
        self.animate_sky = false;
        for batch in 0..20 {
            // Balanced ABBA/BAAB blocks with a deterministic shuffled order.
            let hash = (batch as u32 / 2)
                .wrapping_mul(1_103_515_245)
                .wrapping_add(12345);
            let order = if (hash.count_ones() as usize + batch % 2).is_multiple_of(2) {
                [0, 1]
            } else {
                [1, 0]
            };
            for index in order {
                self.probe = variants[index];
                for frame in 0..30 {
                    let u = path[(batch * 24 + frame + path.len() - 6 % path.len()) % path.len()];
                    let start = std::time::Instant::now();
                    let command = self.encode(&target, u, paint, 1.0)?;
                    let cpu = start.elapsed().as_secs_f64() * 1000.0;
                    command.commit();
                    self.inflight.push_back(command);
                    self.finish()?;
                    if frame >= 6 {
                        let wall = start.elapsed().as_secs_f64() * 1000.0;
                        let sample = &mut samples[index];
                        sample.gpu.push(self.gpu_ms);
                        sample.wall.push(wall);
                        sample.cpu.push(cpu);
                        sample.allocations += self.dynamic_allocations;
                        sample.shadow_hits += usize::from(self.shadow_cache_hit);
                    }
                }
            }
        }
        Ok(samples)
    }
    pub fn benchmark_paint_path(
        &mut self,
        path: &[Uniforms],
        size: [usize; 2],
        paint: &[egui::ClippedPrimitive],
    ) -> Result<(Vec<f64>, Vec<f64>, Vec<f64>)> {
        let target = self.offscreen_texture(size[0], size[1])?;
        let (mut gpu, mut wall, mut encode) = (Vec::new(), Vec::new(), Vec::new());
        self.animate_sky = false;
        self.benchmark_allocations = 0;
        self.benchmark_shadow_hits = 0;
        for i in 0..144 {
            let start = std::time::Instant::now();
            let command = self.encode(&target, path[i % path.len()], paint, 1.0)?;
            let cpu = start.elapsed().as_secs_f64() * 1000.0;
            command.commit();
            self.inflight.push_back(command);
            self.finish()?;
            if i >= 24 {
                self.benchmark_allocations += self.dynamic_allocations;
                self.benchmark_shadow_hits += usize::from(self.shadow_cache_hit);
                gpu.push(self.gpu_ms);
                wall.push(start.elapsed().as_secs_f64() * 1000.0);
                encode.push(cpu);
            }
        }
        Ok((gpu, wall, encode))
    }
    pub fn draw(
        &mut self,
        uniforms: Uniforms,
        paint: &[egui::ClippedPrimitive],
        pixels_per_point: f32,
        capture: Option<&Path>,
    ) -> Result<bool> {
        let Some(drawable) = self.layer.as_ref().and_then(|l| l.nextDrawable()) else {
            return Ok(false);
        };
        let texture = drawable.texture();
        let command = self.encode(&texture, uniforms, paint, pixels_per_point)?;
        command.presentDrawable(ProtocolObject::from_ref(&*drawable));
        command.commit();
        if let Some(path) = capture {
            command.waitUntilCompleted();
            // Drawable textures are private. Copy to a shared texture before CPU readback.
            let target = self.offscreen_texture(texture.width(), texture.height())?;
            let copy = self
                .queue
                .commandBuffer()
                .context("Create capture command")?;
            let blit = copy
                .blitCommandEncoder()
                .context("Create capture encoder")?;
            unsafe {
                blit.copyFromTexture_sourceSlice_sourceLevel_sourceOrigin_sourceSize_toTexture_destinationSlice_destinationLevel_destinationOrigin(&texture,0,0,MTLOrigin{x:0,y:0,z:0},MTLSize{width:texture.width(),height:texture.height(),depth:1},&target,0,0,MTLOrigin{x:0,y:0,z:0});
            }
            blit.endEncoding();
            copy.commit();
            copy.waitUntilCompleted();
            self.write_png(&target, path)?;
        }
        self.inflight.push_back(command);
        if self.inflight.len() >= 3 {
            self.wait_oldest()?;
        }
        Ok(true)
    }
    fn wait_oldest(&mut self) -> Result<()> {
        if let Some(c) = self.inflight.pop_front() {
            c.waitUntilCompleted();
            if c.status() == MTLCommandBufferStatus::Error {
                return Err(anyhow!("Metal command error: {:?}", c.error()));
            }
            self.gpu_ms = (c.GPUEndTime() - c.GPUStartTime()) * 1000.0;
        }
        Ok(())
    }
    pub fn finish(&mut self) -> Result<()> {
        while !self.inflight.is_empty() {
            self.wait_oldest()?;
        }
        Ok(())
    }
    pub fn draw_offscreen(
        &mut self,
        uniforms: Uniforms,
        size: [usize; 2],
        path: &Path,
    ) -> Result<()> {
        let texture = self.offscreen_texture(size[0], size[1])?;
        let command = self.encode(&texture, uniforms, &[], 1.0)?;
        command.commit();
        self.inflight.push_back(command);
        self.finish()?;
        self.write_png(&texture, path)
    }
    fn prepare_visibility(
        &mut self,
        uniforms: Uniforms,
        frame: &FrameUniforms,
        render_shadow: bool,
    ) -> Result<()> {
        if !self.probe.grouped_quads
            && !self.probe.compact_faces
            && !self.probe.fine_culling
            && self.reference_pipelines.is_none()
        {
            let library = self
                .device
                .newLibraryWithSource_options_error(
                    &NSString::from_str(include_str!("../shaders/space.metal")),
                    None,
                )
                .map_err(|e| anyhow!("Reference shader: {e}"))?;
            self.reference_pipelines = Some(vec![
                make_pipeline(
                    &self.device,
                    &library,
                    "legacy_vertex",
                    "voxel_fragment",
                    false,
                    MTLPixelFormat::RGBA16Float,
                    4,
                    true,
                )?,
                make_pipeline(
                    &self.device,
                    &library,
                    "legacy_vertex",
                    "voxel_fragment",
                    true,
                    MTLPixelFormat::RGBA16Float,
                    4,
                    true,
                )?,
                make_pipeline(
                    &self.device,
                    &library,
                    "legacy_shadow_vertex",
                    "replay_shadow_fragment",
                    false,
                    MTLPixelFormat::Invalid,
                    1,
                    true,
                )?,
            ]);
        }
        let create = |bytes: &[u8]| {
            unsafe {
                self.device.newBufferWithBytes_length_options(
                    ptr(bytes),
                    bytes.len(),
                    MTLResourceOptions::StorageModeShared,
                )
            }
            .context("Allocate visibility/reference buffer")
        };
        let eye = Vec3::new(frame.eye[0], frame.eye[1], frame.eye[2]);
        let mut views = [
            CullView::new(
                Mat4::from_cols_array_2d(&uniforms.clip),
                eye,
                uniforms.options[0] > 0.5,
                true,
            ),
            CullView::new(
                Mat4::from_cols_array_2d(&frame.shadow),
                eye,
                uniforms.options[0] > 0.5,
                false,
            ),
        ];
        for view in &mut views {
            view.inherit_proofs = self.probe.inherit_cull_proofs;
            view.leaf_proofs = self.probe.leaf_cull_proofs;
        }
        let mut jobs = Vec::new();
        let camera = Vec3::new(uniforms.camera[0], uniforms.camera[1], uniforms.camera[2]);
        let coarse = self.probe.cache_submission.then(|| {
            [
                geometry::Frustum::new(Mat4::from_cols_array_2d(&uniforms.clip)),
                geometry::Frustum::new(Mat4::from_cols_array_2d(&frame.shadow)),
            ]
        });
        for mesh in self.meshes.values_mut() {
            if self.probe.cache_submission {
                let coarse = coarse.as_ref().unwrap();
                mesh.frame_visible = [
                    mesh_visible(mesh, uniforms, frame, false, Some(&coarse[0])),
                    render_shadow && mesh_visible(mesh, uniforms, frame, true, Some(&coarse[1])),
                ];
                if mesh.frame_visible[0] {
                    mesh.frame_distance = mesh_distance(mesh, camera);
                }
            }
            for map in &mut mesh.maps {
                map.active = false;
            }
            if mesh.packed && !self.probe.compact_faces && mesh.reference.is_none() {
                // Diagnostic reference only; normal windows retain only the compact buffer.
                let packed = unsafe {
                    std::slice::from_raw_parts(
                        mesh.buffer.contents().as_ptr().cast::<PackedFace>(),
                        mesh.faces,
                    )
                };
                let faces: Vec<_> = packed.iter().map(|p| p.unpack(mesh.origin)).collect();
                mesh.reference = Some(create(bytemuck::cast_slice(&faces))?);
            }
            if !self.probe.fine_culling || !uses_visibility(mesh, uniforms) {
                continue;
            }
            if mesh.coverage_revision != self.coverage.revision
                || mesh.covered.len() != mesh.blocks.len()
            {
                mesh.covered = mesh
                    .blocks
                    .iter()
                    .map(|b| u8::from(self.coverage.covers(b.flat)))
                    .collect();
                mesh.coverage_revision = self.coverage.revision;
            }
            let visible = if self.probe.cache_submission {
                mesh.frame_visible
            } else {
                [
                    mesh_visible(mesh, uniforms, frame, false, None),
                    render_shadow && mesh_visible(mesh, uniforms, frame, true, None),
                ]
            };
            for (index, map) in mesh.maps.iter_mut().enumerate() {
                let shadow = index == 1;
                if !visible[index] {
                    continue;
                }
                map.active = true;
                let clip = if shadow { frame.shadow } else { uniforms.clip };
                let key = VisibilityKey {
                    inherit_proofs: self.probe.inherit_cull_proofs,
                    leaf_proofs: self.probe.leaf_cull_proofs,
                    clip,
                    camera: uniforms.camera,
                    coverage: self.coverage.revision,
                    torus: uniforms.options[0] > 0.5,
                    hierarchical: self.probe.hierarchical_culling,
                };
                if map.key.as_ref() == Some(&key) {
                    continue;
                }
                let view = &views[usize::from(shadow)];
                if self.probe.hierarchical_culling {
                    jobs.push((
                        &mesh.tree,
                        &mesh.blocks,
                        &mesh.covered,
                        &mut map.scratch,
                        *view,
                    ));
                } else {
                    // Preserve the previous allocation/scan path for an honest reference.
                    map.scratch = Vec::with_capacity(mesh.blocks.len());
                    map.scratch.extend(
                        mesh.blocks
                            .iter()
                            .enumerate()
                            .filter(|(i, b)| mesh.covered[*i] == 0 && view.visible_bounds(b))
                            .map(|(i, _)| i as u32),
                    );
                }
                map.dirty = true;
                map.key = Some(key);
            }
        }
        if !jobs.is_empty() {
            self.visibility_pool.install(|| {
                jobs.par_iter_mut()
                    .for_each(|(tree, blocks, covered, output, view)| {
                        tree.select(blocks, covered, view, output)
                    })
            });
        }
        drop(jobs);
        for mesh in self.meshes.values_mut() {
            for (index, map) in mesh.maps.iter_mut().enumerate() {
                if map.dirty {
                    let view = &views[index];
                    if self.probe.validate_visibility {
                        let expected: Vec<_> = mesh
                            .blocks
                            .iter()
                            .enumerate()
                            .filter(|(i, b)| mesh.covered[*i] == 0 && view.visible_bounds(b))
                            .map(|(i, _)| i as u32)
                            .collect();
                        anyhow::ensure!(
                            map.scratch == expected,
                            "Hierarchical visibility differs from linear reference"
                        );
                    }
                    let faces = map.scratch.len() * BLOCK_FACES
                        - if map
                            .scratch
                            .last()
                            .is_some_and(|&i| (i as usize + 1) * BLOCK_FACES > mesh.faces)
                        {
                            mesh.faces.next_multiple_of(BLOCK_FACES) - mesh.faces
                        } else {
                            0
                        };
                    if map.scratch != map.indices {
                        map.content_revision += 1;
                        map.buffer = None;
                        std::mem::swap(&mut map.scratch, &mut map.indices);
                    }
                    map.faces = faces;
                    map.dirty = false;
                }
                if self.probe.reuse_buffers {
                    map.buffer = None;
                } else if map.active && map.buffer.is_none() && !map.indices.is_empty() {
                    map.buffer = Some(create(bytemuck::cast_slice(&map.indices))?);
                    self.dynamic_allocations += 1;
                }
            }
        }
        if self.probe.reuse_buffers {
            let mut bytes = 0;
            for mesh in self.meshes.values_mut() {
                for map in &mut mesh.maps {
                    if map.active && !map.indices.is_empty() {
                        map.offset = bytes;
                        bytes += (map.indices.len() * 4).next_multiple_of(256);
                    }
                }
            }
            let slot = &mut self.dynamic_slots[self.dynamic_slot];
            if grow_buffer(&self.device, &mut slot.visibility, bytes)? {
                self.dynamic_allocations += 1;
                slot.visibility_layout.clear();
            }
            let mut entry = 0;
            if let Some(buffer) = &slot.visibility {
                for mesh in self.meshes.values() {
                    for (pass, map) in mesh.maps.iter().enumerate() {
                        if map.active && !map.indices.is_empty() {
                            let layout = (
                                mesh.revision,
                                pass,
                                map.content_revision,
                                map.offset,
                                map.indices.len(),
                            );
                            if slot.visibility_layout.get(entry) == Some(&layout) {
                                entry += 1;
                                continue;
                            }
                            let source = bytemuck::cast_slice::<u32, u8>(&map.indices);
                            unsafe {
                                std::ptr::copy_nonoverlapping(
                                    source.as_ptr(),
                                    buffer.contents().as_ptr().cast::<u8>().add(map.offset),
                                    source.len(),
                                );
                            }
                            if entry < slot.visibility_layout.len() {
                                slot.visibility_layout[entry] = layout;
                            } else {
                                slot.visibility_layout.push(layout);
                            }
                            entry += 1;
                        }
                    }
                }
            }
            slot.visibility_layout.truncate(entry);
        }
        Ok(())
    }
    pub fn geometry_bytes(&self) -> usize {
        self.meshes.values().map(|m| m.buffer.length()).sum()
    }
    pub fn msaa_attachment_bytes(&self) -> usize {
        self.targets.as_ref().map_or(0, |t| {
            MTLResource::allocatedSize(&*t.ms_color) + MTLResource::allocatedSize(&*t.ms_depth)
        })
    }
    fn encode(
        &mut self,
        target: &ProtocolObject<dyn MTLTexture>,
        uniforms: Uniforms,
        paint: &[egui::ClippedPrimitive],
        ppp: f32,
    ) -> Result<Metal<dyn MTLCommandBuffer>> {
        // Every submission uses only this slot. No cached map points into an
        // earlier slot, so waiting for the oldest frame fences all CPU writes.
        while self.inflight.len() >= self.dynamic_slots.len() {
            self.wait_oldest()?;
        }
        self.dynamic_slot = (self.dynamic_slot + 1) % self.dynamic_slots.len();
        self.dynamic_allocations = 0;
        let w = target.width();
        let h = target.height();
        let ultra = uniforms.options[3] > 0.5;
        self.ensure_depth(w, h, ultra)?;
        let frame = FrameUniforms::new(
            uniforms,
            w,
            h,
            if self.animate_sky {
                self.started.elapsed().as_secs_f32()
            } else {
                0.0
            },
        );
        let command = self.queue.commandBuffer().context("Create frame command")?;
        let shadow_key = if self.probe.cache_shadows {
            Some(ShadowKey {
                quad_group: self.probe.quad_group,
                camera: uniforms.camera,
                shadow: frame.shadow,
                correction: frame.correction,
                torus: uniforms.options[0] > 0.5,
                coverage: self.coverage.revision,
                draw_modes: [
                    self.probe.grouped_quads,
                    self.probe.compact_faces,
                    self.probe.fine_culling,
                    self.probe.hierarchical_culling,
                    self.probe.skip_far,
                ],
                scene_revision: self.shadow_revision,
            })
        } else {
            None
        };
        self.shadow_cache_hit = shadow_key.is_some() && shadow_key == self.shadow_key;
        let render_shadow = ultra
            && uniforms.options[1] > 0.5
            && !self.probe.freeze_shadow
            && !self.shadow_cache_hit;
        self.prepare_visibility(uniforms, &frame, render_shadow)?;
        let legacy =
            !self.probe.grouped_quads && !self.probe.compact_faces && !self.probe.fine_culling;
        let targets = self.targets.as_ref().unwrap();
        let bind = |encoder: &ProtocolObject<dyn MTLRenderCommandEncoder>, u: &Uniforms| unsafe {
            encoder.setVertexBytes_length_atIndex(
                ptr(std::slice::from_ref(u)),
                std::mem::size_of::<Uniforms>(),
                1,
            );
            encoder.setFragmentBytes_length_atIndex(
                ptr(std::slice::from_ref(u)),
                std::mem::size_of::<Uniforms>(),
                1,
            );
            encoder.setVertexBytes_length_atIndex(
                ptr(std::slice::from_ref(&frame)),
                std::mem::size_of::<FrameUniforms>(),
                2,
            );
            encoder.setFragmentBytes_length_atIndex(
                ptr(std::slice::from_ref(&frame)),
                std::mem::size_of::<FrameUniforms>(),
                2,
            );
        };
        let visible = |mesh: &Mesh, shadow: bool| {
            if self.probe.cache_submission {
                mesh.frame_visible[usize::from(shadow)]
            } else {
                mesh_visible(mesh, uniforms, &frame, shadow, None)
            }
        };
        let draw_mesh = |encoder: &ProtocolObject<dyn MTLRenderCommandEncoder>,
                         mesh: &Mesh,
                         shadow: bool| {
            let mut u = uniforms;
            let culled = self.probe.fine_culling && uses_visibility(mesh, uniforms);
            let map = &mesh.maps[usize::from(shadow)];
            let faces = if culled { map.faces } else { mesh.faces };
            if faces == 0 {
                return 0;
            }
            let slots = if culled {
                map.indices.len() * BLOCK_FACES
            } else {
                mesh.faces
            };
            let compact = mesh.packed && self.probe.compact_faces;
            let group = if self.probe.grouped_quads {
                self.probe.quad_group.clamp(1, MAX_QUAD_GROUP)
            } else {
                1
            };
            let draw = DrawUniforms {
                origin: mesh.origin.extend(0.0).to_array(),
                counts: [
                    mesh.faces as u32,
                    slots as u32,
                    group as u32,
                    u32::from(compact) | u32::from(culled) << 1,
                ],
            };
            u.model = mesh.model.to_cols_array_2d();
            u.options[2] = if mesh.model == Mat4::IDENTITY {
                1.0
            } else {
                0.0
            };
            if self.probe.reuse_buffers {
                // The frame and torus tables are identical for every draw in
                // this pass; only the model and per-draw lattice mode change.
                unsafe {
                    encoder.setVertexBytes_length_atIndex(
                        ptr(std::slice::from_ref(&u)),
                        std::mem::size_of::<Uniforms>(),
                        1,
                    );
                    encoder.setFragmentBytes_length_atIndex(
                        ptr(std::slice::from_ref(&u)),
                        std::mem::size_of::<Uniforms>(),
                        1,
                    );
                }
            } else {
                bind(encoder, &u);
            }
            unsafe {
                let data = if mesh.packed && !compact {
                    mesh.reference.as_ref().unwrap()
                } else {
                    &mesh.buffer
                };
                encoder.setVertexBuffer_offset_atIndex(Some(data), 0, 0);
                encoder.setVertexBytes_length_atIndex(
                    ptr(std::slice::from_ref(&draw)),
                    std::mem::size_of::<DrawUniforms>(),
                    5,
                );
                encoder.setVertexBuffer_offset_atIndex(
                    Some(if culled {
                        if self.probe.reuse_buffers {
                            self.dynamic_slots[self.dynamic_slot]
                                .visibility
                                .as_ref()
                                .unwrap()
                        } else {
                            map.buffer.as_ref().unwrap()
                        }
                    } else {
                        &self.quad_indices
                    }),
                    if culled && self.probe.reuse_buffers {
                        map.offset
                    } else {
                        0
                    },
                    6,
                );
                if !self.probe.reuse_buffers {
                    encoder.setVertexBuffer_offset_atIndex(Some(&self.theta_table), 0, 3);
                    encoder.setVertexBuffer_offset_atIndex(Some(&self.phi_table), 0, 4);
                }
                encoder.drawIndexedPrimitives_indexCount_indexType_indexBuffer_indexBufferOffset_instanceCount(MTLPrimitiveType::Triangle,6*group,MTLIndexType::UInt16,&self.quad_indices,0,slots.div_ceil(group));
            }
            faces
        };
        let draw_replay = |encoder: &ProtocolObject<dyn MTLRenderCommandEncoder>| {
            bind(encoder, &uniforms);
            unsafe {
                encoder.setFragmentTexture_atIndex(Some(&self.mask), 1);
            }
            for mesh in &self.replay {
                encoder.setCullMode(if mesh.cull {
                    MTLCullMode::Back
                } else {
                    MTLCullMode::None
                });
                encoder.setFrontFacingWinding(MTLWinding::CounterClockwise);
                unsafe {
                    encoder.setVertexBuffer_offset_atIndex(Some(&mesh.vertices), 0, 0);
                    encoder
                        .drawIndexedPrimitives_indexCount_indexType_indexBuffer_indexBufferOffset(
                            MTLPrimitiveType::Triangle,
                            mesh.count,
                            MTLIndexType::UInt32,
                            &mesh.indices,
                            0,
                        );
                }
            }
            encoder.setCullMode(MTLCullMode::None);
        };
        let mut shadow_faces = 0;
        let mut shadow_draws = 0;
        let bind_pass = |encoder: &ProtocolObject<dyn MTLRenderCommandEncoder>| {
            bind(encoder, &uniforms);
            unsafe {
                encoder.setVertexBuffer_offset_atIndex(Some(&self.theta_table), 0, 3);
                encoder.setVertexBuffer_offset_atIndex(Some(&self.phi_table), 0, 4);
            }
        };
        if render_shadow {
            let pass = MTLRenderPassDescriptor::new();
            let d = pass.depthAttachment();
            d.setTexture(Some(&self.shadow_map));
            d.setLoadAction(MTLLoadAction::Clear);
            d.setStoreAction(MTLStoreAction::Store);
            d.setClearDepth(1.0);
            let encoder = command
                .renderCommandEncoderWithDescriptor(&pass)
                .context("Shadow encoder")?;
            if self.probe.reuse_buffers {
                bind_pass(&encoder);
            }
            encoder.setCullMode(MTLCullMode::None);
            encoder.setDepthStencilState(Some(&self.depth_state));
            encoder.setRenderPipelineState(if legacy {
                &self.reference_pipelines.as_ref().unwrap()[2]
            } else {
                &self.shadow_pipeline
            });
            unsafe {
                encoder.setFragmentTexture_atIndex(Some(&self.mask), 1);
            }
            for (key, mesh) in &self.meshes {
                if casts_shadow(key)
                    && !(self.probe.skip_far && key.starts_with("far:"))
                    && visible(mesh, true)
                {
                    let faces = draw_mesh(&encoder, mesh, true);
                    shadow_faces += faces;
                    shadow_draws += usize::from(faces > 0);
                }
            }
            encoder.setRenderPipelineState(&self.replay_shadow_pipeline);
            draw_replay(&encoder);
            shadow_faces += self.replay.iter().map(|m| m.count / 6).sum::<usize>();
            shadow_draws += self.replay.len();
            encoder.endEncoding();
            self.shadow_key = shadow_key;
        }
        self.shadow_faces = shadow_faces;
        self.shadow_draws = shadow_draws;
        let pass = MTLRenderPassDescriptor::new();
        let color = unsafe { pass.colorAttachments().objectAtIndexedSubscript(0) };
        color.setTexture(Some(&targets.ms_color));
        color.setResolveTexture(Some(if ultra { &*targets.scene } else { target }));
        color.setLoadAction(MTLLoadAction::Clear);
        color.setStoreAction(MTLStoreAction::MultisampleResolve);
        let depth = pass.depthAttachment();
        depth.setTexture(Some(&targets.ms_depth));
        if ultra {
            depth.setResolveTexture(Some(&targets.depth));
        }
        depth.setLoadAction(MTLLoadAction::Clear);
        depth.setStoreAction(if ultra {
            MTLStoreAction::MultisampleResolve
        } else {
            MTLStoreAction::DontCare
        });
        depth.setDepthResolveFilter(MTLMultisampleDepthResolveFilter::Min);
        depth.setClearDepth(1.0);
        let encoder = command
            .renderCommandEncoderWithDescriptor(&pass)
            .context("HDR scene encoder")?;
        encoder.setCullMode(MTLCullMode::None);
        encoder.setDepthStencilState(Some(&self.ui_depth));
        encoder.setRenderPipelineState(if ultra {
            &self.sky_pipeline
        } else {
            &self.baseline[3]
        });
        bind(&encoder, &uniforms);
        if self.probe.reuse_buffers {
            bind_pass(&encoder);
        }
        unsafe {
            encoder.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 3);
        }
        self.draw_calls = 0;
        self.visible_faces = 0;
        for transparent in [false, true] {
            encoder.setRenderPipelineState(if !ultra {
                &self.baseline[usize::from(transparent)]
            } else if legacy {
                &self.reference_pipelines.as_ref().unwrap()[usize::from(transparent)]
            } else if transparent {
                &self.transparent_pipeline
            } else {
                &self.pipeline
            });
            encoder.setCullMode(if transparent {
                MTLCullMode::None
            } else {
                MTLCullMode::Back
            });
            encoder.setFrontFacingWinding(MTLWinding::CounterClockwise);
            encoder.setDepthStencilState(Some(if transparent {
                &self.transparent_depth
            } else {
                &self.depth_state
            }));
            unsafe {
                encoder.setFragmentTexture_atIndex(Some(&self.shadow_map), 0);
                encoder.setFragmentTexture_atIndex(Some(&self.mask), 1);
            }
            let camera = Vec3::new(uniforms.camera[0], uniforms.camera[1], uniforms.camera[2]);
            let mut meshes: Vec<_> = self
                .meshes
                .iter()
                .filter(|(key, mesh)| {
                    key.ends_with(":alpha") == transparent
                        && !(self.probe.skip_far && key.starts_with("far:"))
                        && visible(mesh, false)
                })
                .collect();
            if self.probe.cache_submission {
                // Unique mesh names break every distance tie, so in-place
                // sorting preserves the exact draw order without scratch storage.
                meshes.sort_unstable_by(|a, b| {
                    let order = a.1.frame_distance.total_cmp(&b.1.frame_distance);
                    let order = if transparent { order.reverse() } else { order };
                    order.then_with(|| a.0.cmp(b.0))
                });
            } else {
                meshes.sort_by(|a, b| {
                    let order = mesh_distance(a.1, camera).total_cmp(&mesh_distance(b.1, camera));
                    let order = if transparent { order.reverse() } else { order };
                    order.then_with(|| a.0.cmp(b.0))
                });
            }
            for (_, mesh) in meshes {
                let faces = draw_mesh(&encoder, mesh, false);
                self.draw_calls += usize::from(faces > 0);
                self.visible_faces += faces;
            }
            if !transparent {
                encoder.setRenderPipelineState(if ultra {
                    &self.replay_pipeline
                } else {
                    &self.baseline[2]
                });
                draw_replay(&encoder);
                self.draw_calls += self.replay.len();
                self.visible_faces += self.replay.iter().map(|m| m.count / 6).sum::<usize>();
            }
        }
        encoder.endEncoding();
        let fullscreen = |name: &str,
                          target: &ProtocolObject<dyn MTLTexture>,
                          inputs: &[&ProtocolObject<dyn MTLTexture>],
                          blur: Option<[f32; 4]>|
         -> Result<()> {
            let pass = MTLRenderPassDescriptor::new();
            let color = unsafe { pass.colorAttachments().objectAtIndexedSubscript(0) };
            color.setTexture(Some(target));
            color.setLoadAction(MTLLoadAction::DontCare);
            color.setStoreAction(MTLStoreAction::Store);
            let e = command
                .renderCommandEncoderWithDescriptor(&pass)
                .context("Postprocess encoder")?;
            e.setRenderPipelineState(&self.post[name]);
            bind(&e, &uniforms);
            unsafe {
                for (i, t) in inputs.iter().enumerate() {
                    e.setFragmentTexture_atIndex(Some(t), i);
                }
                if let Some(p) = blur {
                    e.setFragmentBytes_length_atIndex(ptr(&p), 16, 3);
                }
                e.drawPrimitives_vertexStart_vertexCount(MTLPrimitiveType::Triangle, 0, 3);
            }
            e.endEncoding();
            Ok(())
        };
        if ultra && self.probe.skip_post {
            fullscreen("copy_fragment", target, &[&targets.scene], None)?;
        } else if ultra {
            if !self.probe.freeze_secondary {
                fullscreen(
                    "secondary_fragment",
                    &targets.secondary,
                    &[&targets.scene, &targets.depth],
                    None,
                )?;
            }
            fullscreen(
                "atmosphere_fragment",
                &targets.atmosphere,
                &[&targets.scene, &targets.depth, &targets.secondary],
                None,
            )?;
            if !self.probe.freeze_bloom {
                fullscreen(
                    "bloom_extract",
                    &targets.bright,
                    &[&targets.scene, &targets.atmosphere],
                    None,
                )?;
                for (i, (horizontal, vertical)) in targets.bloom.iter().enumerate() {
                    let source = if i == 0 {
                        &targets.bright
                    } else {
                        &targets.bloom[i - 1].1
                    };
                    let radius = (6 + i * 4) as f32;
                    fullscreen(
                        "bloom_blur",
                        horizontal,
                        &[source],
                        Some([1.0 / horizontal.width() as f32, 0.0, radius, radius / 3.0]),
                    )?;
                    fullscreen(
                        "bloom_blur",
                        vertical,
                        &[horizontal],
                        Some([0.0, 1.0 / vertical.height() as f32, radius, radius / 3.0]),
                    )?;
                }
            }
            let mut inputs: Vec<&ProtocolObject<dyn MTLTexture>> = vec![&targets.atmosphere];
            for (_, t) in &targets.bloom {
                inputs.push(t);
            }
            fullscreen("output_fragment", &targets.display, &inputs, None)?;
            fullscreen("fxaa_fragment", target, &[&targets.display], None)?;
        }
        if paint.is_empty() {
            return Ok(command);
        }
        if self.probe.reuse_buffers {
            let bytes = paint
                .iter()
                .map(|p| {
                    if let egui::epaint::Primitive::Mesh(mesh) = &p.primitive {
                        (mesh.vertices.len() * std::mem::size_of::<UiVertex>())
                            .next_multiple_of(256)
                            + (mesh.indices.len() * 4).next_multiple_of(256)
                    } else {
                        0
                    }
                })
                .sum();
            self.dynamic_allocations += usize::from(grow_buffer(
                &self.device,
                &mut self.dynamic_slots[self.dynamic_slot].ui,
                bytes,
            )?);
        }
        let pass = MTLRenderPassDescriptor::new();
        let color = unsafe { pass.colorAttachments().objectAtIndexedSubscript(0) };
        color.setTexture(Some(target));
        color.setLoadAction(MTLLoadAction::Load);
        color.setStoreAction(MTLStoreAction::Store);
        let encoder = command
            .renderCommandEncoderWithDescriptor(&pass)
            .context("UI encoder")?;
        encoder.setRenderPipelineState(&self.ui_pipeline);
        encoder.setDepthStencilState(Some(&self.ui_depth));
        let screen = [w as f32 / ppp, h as f32 / ppp];
        unsafe {
            encoder.setVertexBytes_length_atIndex(ptr(&screen), 8, 1);
            encoder.setFragmentSamplerState_atIndex(Some(&self.sampler), 0);
        }
        let mut ui_offset = 0;
        for primitive in paint {
            let egui::epaint::Primitive::Mesh(mesh) = &primitive.primitive else {
                continue;
            };
            if mesh.vertices.is_empty() || mesh.indices.is_empty() {
                continue;
            }
            let Some(texture) = self.textures.get(&mesh.texture_id) else {
                continue;
            };
            let clip = primitive.clip_rect;
            let x = (clip.min.x * ppp).floor().max(0.0).min(w as f32) as usize;
            let y = (clip.min.y * ppp).floor().max(0.0).min(h as f32) as usize;
            let right = (clip.max.x * ppp).ceil().max(0.0).min(w as f32) as usize;
            let bottom = (clip.max.y * ppp).ceil().max(0.0).min(h as f32) as usize;
            if right <= x || bottom <= y {
                continue;
            }
            let vertex = |v: &egui::epaint::Vertex| UiVertex {
                pos: [v.pos.x, v.pos.y],
                uv: [v.uv.x, v.uv.y],
                color: u32::from_le_bytes(v.color.to_array()),
            };
            let (vb, ib, vertex_offset, index_offset) = if self.probe.reuse_buffers {
                let buffer = self.dynamic_slots[self.dynamic_slot].ui.as_ref().unwrap();
                let vertex_offset = ui_offset;
                let index_offset = vertex_offset
                    + (mesh.vertices.len() * std::mem::size_of::<UiVertex>()).next_multiple_of(256);
                ui_offset = index_offset + (mesh.indices.len() * 4).next_multiple_of(256);
                unsafe {
                    let out = buffer
                        .contents()
                        .as_ptr()
                        .cast::<u8>()
                        .add(vertex_offset)
                        .cast::<UiVertex>();
                    for (i, v) in mesh.vertices.iter().enumerate() {
                        out.add(i).write(vertex(v));
                    }
                    let source = bytemuck::cast_slice::<u32, u8>(&mesh.indices);
                    std::ptr::copy_nonoverlapping(
                        source.as_ptr(),
                        buffer.contents().as_ptr().cast::<u8>().add(index_offset),
                        source.len(),
                    );
                }
                (buffer.clone(), buffer.clone(), vertex_offset, index_offset)
            } else {
                let vertices: Vec<_> = mesh.vertices.iter().map(vertex).collect();
                self.dynamic_allocations += 2;
                (
                    self.buffer(bytemuck::cast_slice(&vertices))?,
                    self.buffer(bytemuck::cast_slice(&mesh.indices))?,
                    0,
                    0,
                )
            };
            encoder.setScissorRect(MTLScissorRect {
                x,
                y,
                width: right - x,
                height: bottom - y,
            });
            unsafe {
                encoder.setVertexBuffer_offset_atIndex(Some(&vb), vertex_offset, 0);
                encoder.setFragmentTexture_atIndex(Some(texture), 0);
                encoder.drawIndexedPrimitives_indexCount_indexType_indexBuffer_indexBufferOffset(
                    MTLPrimitiveType::Triangle,
                    mesh.indices.len(),
                    MTLIndexType::UInt32,
                    &ib,
                    index_offset,
                );
            }
        }
        encoder.endEncoding();
        Ok(command)
    }
    pub fn free_textures(&mut self, ids: &[egui::TextureId]) {
        for id in ids {
            self.textures.remove(id);
        }
    }
    fn read_pixels(texture: &ProtocolObject<dyn MTLTexture>) -> Vec<u8> {
        let w = texture.width();
        let h = texture.height();
        let mut data = vec![0_u8; w * h * 4];
        unsafe {
            texture.getBytes_bytesPerRow_fromRegion_mipmapLevel(
                NonNull::new(data.as_mut_ptr().cast()).unwrap(),
                w * 4,
                MTLRegion {
                    origin: MTLOrigin { x: 0, y: 0, z: 0 },
                    size: MTLSize {
                        width: w,
                        height: h,
                        depth: 1,
                    },
                },
                0,
            );
        }
        for pixel in data.as_chunks_mut::<4>().0 {
            pixel.swap(0, 2);
        }
        data
    }
    fn write_png(&self, texture: &ProtocolObject<dyn MTLTexture>, path: &Path) -> Result<()> {
        let w = texture.width();
        let h = texture.height();
        let data = Self::read_pixels(texture);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut enc = png::Encoder::new(std::fs::File::create(path)?, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header()?.write_image_data(&data)?;
        Ok(())
    }
}
#[allow(clippy::too_many_arguments)]
fn make_pipeline(
    device: &ProtocolObject<dyn MTLDevice>,
    library: &ProtocolObject<dyn MTLLibrary>,
    vertex: &str,
    fragment: &str,
    blend: bool,
    format: MTLPixelFormat,
    samples: usize,
    depth: bool,
) -> Result<Metal<dyn MTLRenderPipelineState>> {
    let d = MTLRenderPipelineDescriptor::new();
    d.setVertexFunction(
        library
            .newFunctionWithName(&NSString::from_str(vertex))
            .as_deref(),
    );
    if !fragment.is_empty() {
        d.setFragmentFunction(
            library
                .newFunctionWithName(&NSString::from_str(fragment))
                .as_deref(),
        );
    }
    d.setRasterSampleCount(samples);
    if depth {
        d.setDepthAttachmentPixelFormat(MTLPixelFormat::Depth32Float);
    }
    let color = unsafe { d.colorAttachments().objectAtIndexedSubscript(0) };
    color.setPixelFormat(format);
    if blend {
        color.setBlendingEnabled(true);
        color.setSourceRGBBlendFactor(if vertex == "ui_vertex" {
            MTLBlendFactor::One
        } else {
            MTLBlendFactor::SourceAlpha
        });
        color.setDestinationRGBBlendFactor(MTLBlendFactor::OneMinusSourceAlpha);
        color.setSourceAlphaBlendFactor(MTLBlendFactor::One);
        color.setDestinationAlphaBlendFactor(MTLBlendFactor::OneMinusSourceAlpha);
    }
    device
        .newRenderPipelineStateWithDescriptor_error(&d)
        .map_err(|e| anyhow!("Metal pipeline {vertex}: {e}"))
}

fn texture(
    device: &ProtocolObject<dyn MTLDevice>,
    w: usize,
    h: usize,
    format: MTLPixelFormat,
    samples: usize,
) -> Result<Metal<dyn MTLTexture>> {
    texture_with_storage(device, w, h, format, samples, false)
}
fn texture_with_storage(
    device: &ProtocolObject<dyn MTLDevice>,
    w: usize,
    h: usize,
    format: MTLPixelFormat,
    samples: usize,
    memoryless: bool,
) -> Result<Metal<dyn MTLTexture>> {
    let d = unsafe {
        MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
            format, w, h, false,
        )
    };
    d.setUsage(if memoryless {
        MTLTextureUsage::RenderTarget
    } else {
        MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead
    });
    d.setStorageMode(if memoryless {
        MTLStorageMode::Memoryless
    } else {
        MTLStorageMode::Private
    });
    if samples > 1 {
        d.setTextureType(MTLTextureType::Type2DMultisample);
        unsafe {
            d.setSampleCount(samples);
        }
    }
    device
        .newTextureWithDescriptor(&d)
        .context("Allocate Ultra render target")
}
