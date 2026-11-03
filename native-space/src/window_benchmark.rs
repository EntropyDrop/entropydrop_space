//! Actual window cadence with the normal streaming, simulation, UI and present loop.
//! Benchmark sessions are ephemeral and never write the player's save.
use super::*;
use crate::render_benchmark::summary;
use objc2_metal::MTLDevice;

#[derive(Clone, Copy, PartialEq)]
pub enum Experiment {
    Packed,
    FrameFlow,
    Streaming,
    Startup,
}
impl Experiment {
    fn name(self) -> &'static str {
        match self {
            Self::Packed => "packed-varyings",
            Self::FrameFlow => "frameflow",
            Self::Streaming => "streaming",
            Self::Startup => "startup",
        }
    }
}
pub struct WindowBenchmark {
    pub occluded: bool,
    pub focused: bool,
    output: PathBuf,
    control: bool,
    experiment: Experiment,
    coverage_ready_ms: Option<f64>,
    refinement_ready_ms: Option<f64>,
    startup_unfocused_frames: usize,
    startup_occluded_frames: usize,
    startup_sizes: Vec<[u32; 2]>,
    loaded: Instant,
    block_start: Option<Instant>,
    warm_start: Option<Instant>,
    size: Option<[u32; 2]>,
    last_frame: Instant,
    block: usize,
    frame_ms: Vec<f64>,
    gpu_ms: Vec<f64>,
    faces: Vec<usize>,
    pre_render_ms: Vec<f64>,
    render_present_ms: Vec<f64>,
    draw_timings: [Vec<f64>; 4],
    rows: Vec<serde_json::Value>,
}
impl WindowBenchmark {
    pub fn new(root: &Path, control: bool, experiment: Experiment) -> Self {
        Self {
            occluded: false,
            focused: false,
            output: root.join(if experiment != Experiment::Packed {
                format!("results/window-{}.json", experiment.name())
            } else if control {
                "results/window-gpu-control.json".into()
            } else {
                "results/window-gpu.json".into()
            }),
            control,
            experiment,
            coverage_ready_ms: None,
            refinement_ready_ms: None,
            startup_unfocused_frames: 0,
            startup_occluded_frames: 0,
            startup_sizes: Vec::new(),
            loaded: Instant::now(),
            block_start: None,
            warm_start: None,
            size: None,
            last_frame: Instant::now(),
            block: 0,
            frame_ms: Vec::new(),
            gpu_ms: Vec::new(),
            faces: Vec::new(),
            pre_render_ms: Vec::new(),
            render_present_ms: Vec::new(),
            draw_timings: Default::default(),
            rows: Vec::new(),
        }
    }
    fn candidate(&self) -> bool {
        [
            false, true, true, false, false, true, true, false, true, false, false, true, true,
            false, false, true,
        ][self.block]
    }
    fn control_block(&self) -> bool {
        self.control || (self.block / 4) % 2 == 1
    }
    pub fn before_frame(&self, game: &mut Game, renderer: &mut Renderer) {
        let mut camera = Camera::overlooking(DVec3::from_array(game.world.source.manifest.spawn));
        let t = self
            .block_start
            .or(self.warm_start)
            .map_or(0.0, |s| s.elapsed().as_secs_f64())
            * std::f64::consts::TAU
            / 4.0;
        camera.position += DVec3::new(t.sin() * 8.0, 0.0, t.cos() * 8.0);
        camera.yaw += t.sin() * 0.5;
        game.camera = camera;
        game.ephemeral = true;
        game.vsync = false;
        renderer.set_vsync(false);
        let optimized = self.candidate() && !self.control_block();
        match self.experiment {
            Experiment::FrameFlow => {
                renderer.probe.late_drawable = optimized;
                renderer.probe.fused_present = optimized;
            }
            Experiment::Packed => renderer.probe.packed_varyings = optimized,
            Experiment::Streaming => {
                game.stream_optimized = self.block_start.is_none() || optimized;
            }
            Experiment::Startup => {}
        }
    }
    pub fn after_frame(
        &mut self,
        game: &Game,
        renderer: &mut Renderer,
        size: [u32; 2],
        submitted: bool,
        phases: [f64; 2],
    ) -> Result<bool> {
        let now = Instant::now();
        if self.experiment == Experiment::Startup {
            self.startup_unfocused_frames += usize::from(!self.focused);
            self.startup_occluded_frames += usize::from(self.occluded);
            if self.startup_sizes.last() != Some(&size) {
                self.startup_sizes.push(size);
            }
            anyhow::ensure!(
                self.loaded.elapsed().as_secs() < 600,
                "Startup loading timed out"
            );
            let elapsed = self.loaded.elapsed().as_secs_f64() * 1000.0;
            if submitted && game.distant_tiles.is_empty() {
                if game.distant_zones == 128 && self.coverage_ready_ms.is_none() {
                    self.coverage_ready_ms = Some(elapsed);
                }
                if game.distant_ready && self.refinement_ready_ms.is_none() {
                    self.refinement_ready_ms = Some(elapsed);
                }
            }
            if let Some(refinement_ready_ms) = self.refinement_ready_ms
                && game.near_demand.complete
                && game.streaming.pending.is_empty()
                && game.meshes_inflight.is_empty()
            {
                renderer.finish()?;
                storage::atomic_write(
                    &self.output,
                    &serde_json::to_vec_pretty(&serde_json::json!({
                        "experiment":"startup", "device":renderer.device.name().to_string(),
                        "world":game.world.source.manifest.world, "resolution":size,
                        "quality":"Ultra", "msaa":4, "shadow_map":4096, "render_scale":1,
                        "focused":self.focused, "occluded":self.occluded,
                    "unfocused_frames":self.startup_unfocused_frames, "occluded_frames":self.startup_occluded_frames,
                    "sizes":self.startup_sizes,
                        "stream_optimized":game.stream_optimized,
                        "legacy_lod":std::env::var("SPACE_NATIVE_LEGACY_LOD").as_deref()==Ok("1"),
                        "coverage_ready_ms":self.coverage_ready_ms, "refinement_ready_ms":self.refinement_ready_ms,
                        "all_ready_ms":elapsed, "resident_faces":renderer.resident_faces(),
                        "near_chunks":game.world.chunks.len(), "lod":game.distant_status,
                        "limitations":["Times start at benchmark construction, including window and engine startup.",
                            "Coverage may be cached 64-unit mips; refinement uses the original full source and face budgets.",
                            "The diagnostic is ephemeral and never writes player saves."]
                    }))?,
                )?;
                println!(
                    "Window startup: coverage {:.2} ms, refinement {:.2} ms, all {:.2} ms",
                    self.coverage_ready_ms.unwrap_or(elapsed),
                    refinement_ready_ms,
                    elapsed
                );
                return Ok(true);
            }
            return Ok(false);
        }
        anyhow::ensure!(
            !self.occluded || self.block_start.is_none(),
            "Window occluded during GPU comparison"
        );
        anyhow::ensure!(
            self.focused || self.block_start.is_none(),
            "Window lost focus during GPU comparison"
        );
        anyhow::ensure!(
            submitted || self.block_start.is_none(),
            "Window drawable unavailable during comparison"
        );
        if self.block_start.is_none() {
            if self.warm_start.is_none() {
                anyhow::ensure!(
                    self.loaded.elapsed().as_secs() < 600,
                    "Window benchmark loading timed out: {}",
                    game.distant_status
                );
                if self.focused
                    && !self.occluded
                    && game.distant_ready
                    && game.distant_tiles.is_empty()
                    && game.streaming.pending.is_empty()
                    && game.meshes_inflight.is_empty()
                {
                    self.warm_start = Some(now);
                    println!("Window GPU warm-up: 24 seconds over the moving path");
                }
            } else if self.occluded || !self.focused {
                self.warm_start = Some(now);
            } else if self.warm_start.unwrap().elapsed().as_secs_f64() >= 24.0 {
                // Movement intentionally keeps streaming active. Once the
                // settled starting point has warmed, do not wait for moving
                // publication queues to become empty again.
                self.block_start = Some(now);
                self.size = Some(size);
                println!(
                    "Window GPU benchmark ready: {size:?}, {} faces, Ultra 100%, vsync off, focused={}",
                    renderer.resident_faces(),
                    self.focused
                );
            }
            self.last_frame = now;
            return Ok(false);
        }
        let start = self.block_start.unwrap();
        anyhow::ensure!(
            self.size == Some(size),
            "Window resized during GPU comparison"
        );
        // Exclude transition, pipeline warm-up and queue drain from both modes.
        if submitted && self.last_frame.duration_since(start).as_secs_f64() >= 2.0 {
            self.frame_ms
                .push(now.duration_since(self.last_frame).as_secs_f64() * 1000.0);
            self.gpu_ms.push(renderer.gpu_ms);
            self.faces.push(renderer.visible_faces);
            self.pre_render_ms.push(phases[0]);
            self.render_present_ms.push(phases[1]);
            for (samples, value) in self.draw_timings.iter_mut().zip(renderer.draw_timings) {
                samples.push(value);
            }
        }
        self.last_frame = now;
        if start.elapsed().as_secs_f64() < 6.0 {
            return Ok(false);
        }
        anyhow::ensure!(!self.frame_ms.is_empty(), "Window submitted no frames");
        let fps = self.frame_ms.len() as f64 * 1000.0 / self.frame_ms.iter().sum::<f64>();
        println!(
            "Window block {} candidate={} actual={} FPS {fps:.2} GPU {:.3} ms",
            self.block,
            self.candidate(),
            self.candidate() && !self.control_block(),
            summary(&self.gpu_ms)["p50"].as_f64().unwrap()
        );
        self.rows.push(serde_json::json!({"block":self.block,"occluded":self.occluded,"focused":self.focused,"control":self.control_block(),"candidate":self.candidate(),"stream_optimized":game.stream_optimized,"packed":renderer.probe.packed_varyings,"late_drawable":renderer.probe.late_drawable,"fused_present":renderer.probe.fused_present,
            "fps":fps,"frame_ms":summary(&self.frame_ms),"gpu_ms":summary(&self.gpu_ms),"raw_frame_ms":self.frame_ms,"raw_gpu_ms":self.gpu_ms,"raw_faces":self.faces,
            "pre_render_ms":summary(&self.pre_render_ms),"render_present_ms":summary(&self.render_present_ms),
            "draw_timings": (["drawable", "encode", "submit", "wait"].into_iter().zip(self.draw_timings.iter().map(|values| summary(values))).collect::<std::collections::BTreeMap<_, _>>()),
            "resident_faces":renderer.resident_faces(),"pending_chunks":game.streaming.pending.len(),"pending_meshes":game.meshes_inflight.len(),"lod":game.distant_status}));
        renderer.finish()?;
        self.block += 1;
        if self.block == 16 {
            storage::atomic_write(
                &self.output,
                &serde_json::to_vec_pretty(
                    &serde_json::json!({"experiment":self.experiment.name(),"device":renderer.device.name().to_string(),"world":game.world.source.manifest.world,"resolution":size,"quality":"Ultra","msaa":4,"shadow_map":4096,"render_scale":1,"vsync":false,"control":self.control,"blocks":self.rows,
                "limitations":["Counts actual window render/present-loop completions, not unique display scanouts; display refresh can cap visible frames.","Normal streaming, physics, UI layout and cloud animation remain active. Camera follows the same four-second path in each block.","24-second moving warm-up, then eight ABBA/BAAB candidate blocks interleaved with eight identical-code control blocks. Two-second warm-up plus four-second samples per block.","GPU durations are elapsed timeline spans from the first scene command start to final command end, including possible scheduling gaps; not isolated busy time. Encoding includes early scene submission. All in-flight work is fenced by its final command.","Player saves are read but never written in this ephemeral diagnostic session."]}),
                )?,
            )?;
            return Ok(true);
        }
        self.frame_ms.clear();
        self.gpu_ms.clear();
        self.faces.clear();
        self.pre_render_ms.clear();
        self.render_present_ms.clear();
        for values in &mut self.draw_timings {
            values.clear();
        }
        self.block_start = Some(Instant::now());
        self.last_frame = Instant::now();
        Ok(false)
    }
}
