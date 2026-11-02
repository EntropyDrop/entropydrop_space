//! Actual window cadence with the normal streaming, simulation, UI and present loop.
//! Benchmark sessions are ephemeral and never write the player's save.
use super::*;
use crate::render_benchmark::summary;
use objc2_metal::MTLDevice;

pub struct WindowBenchmark {
    pub occluded: bool,
    pub focused: bool,
    output: PathBuf,
    control: bool,
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
    rows: Vec<serde_json::Value>,
}
impl WindowBenchmark {
    pub fn new(root: &Path, control: bool) -> Self {
        Self {
            occluded: false,
            focused: false,
            output: root.join(if control {
                "results/window-gpu-control.json"
            } else {
                "results/window-gpu.json"
            }),
            control,
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
        renderer.probe.packed_varyings = self.candidate() && !self.control_block();
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
        anyhow::ensure!(
            !self.occluded || self.block_start.is_none(),
            "Window occluded during GPU comparison"
        );
        anyhow::ensure!(
            self.focused || self.block_start.is_none(),
            "Window lost focus during GPU comparison"
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
                    && game.distant_status.starts_with("LOD 128/128")
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
        self.rows.push(serde_json::json!({"block":self.block,"occluded":self.occluded,"focused":self.focused,"control":self.control_block(),"candidate":self.candidate(),"packed":self.candidate() && !self.control_block(),
            "fps":fps,"frame_ms":summary(&self.frame_ms),"gpu_ms":summary(&self.gpu_ms),"raw_frame_ms":self.frame_ms,"raw_gpu_ms":self.gpu_ms,"raw_faces":self.faces,
            "pre_render_ms":summary(&self.pre_render_ms),"render_present_ms":summary(&self.render_present_ms),
            "resident_faces":renderer.resident_faces(),"pending_chunks":game.streaming.pending.len(),"pending_meshes":game.meshes_inflight.len(),"lod":game.distant_status}));
        renderer.finish()?;
        self.block += 1;
        if self.block == 16 {
            storage::atomic_write(
                &self.output,
                &serde_json::to_vec_pretty(
                    &serde_json::json!({"device":renderer.device.name().to_string(),"world":game.world.source.manifest.world,"resolution":size,"quality":"Ultra","msaa":4,"shadow_map":4096,"render_scale":1,"vsync":false,"control":self.control,"blocks":self.rows,
                "limitations":["Counts actual window render/present-loop completions, not unique display scanouts; display refresh can cap visible frames.","Normal streaming, physics, UI layout and cloud animation remain active. Camera follows the same four-second path in each block.","24-second moving warm-up, then eight ABBA/BAAB candidate blocks interleaved with eight identical-code control blocks. Two-second warm-up plus four-second samples per block. GPU durations are from completed in-flight frames.","Player saves are read but never written in this ephemeral diagnostic session."]}),
                )?,
            )?;
            return Ok(true);
        }
        self.frame_ms.clear();
        self.gpu_ms.clear();
        self.faces.clear();
        self.pre_render_ms.clear();
        self.render_present_ms.clear();
        self.block_start = Some(Instant::now());
        self.last_frame = Instant::now();
        Ok(false)
    }
}
