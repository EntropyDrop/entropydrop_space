//! Bounded IPC to the existing volumetric LOD planner. All geometry renders in Metal.
use crate::{geometry::PackedFace, visibility::VisibilityBlock, world::WorldSource};
use anyhow::{Context, Result, ensure};
use crossbeam_channel::{Receiver, Sender, bounded};
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, Stdio},
};
#[derive(Serialize, Clone)]
pub struct View {
    pub camera: [f64; 3],
    pub height: u32,
    pub torus: bool,
    pub edits: Vec<(crate::world::Cell, u32)>,
}
#[derive(Deserialize)]
pub struct Tile {
    pub key: String,
    pub file: String,
    pub bounds: [f32; 4],
    pub faces: usize,
    pub format: u32,
    pub origin: [f32; 3],
    #[serde(skip)]
    pub data: Vec<PackedFace>,
    #[serde(skip)]
    pub visibility: Vec<VisibilityBlock>,
}
#[derive(Deserialize)]
pub struct Frame {
    pub torus: bool,
    #[serde(rename = "sourceLimitedZones")]
    pub source_limited_zones: usize,
    pub tiles: Vec<Tile>,
    pub zones: usize,
    pub ready: bool,
    #[serde(rename = "refinedZones")]
    pub refined_zones: usize,
    #[serde(rename = "cacheRestoredZones")]
    pub cache_restored_zones: usize,
    #[serde(rename = "sourceBytes")]
    pub source_bytes: usize,
    pub stats: serde_json::Value,
}
pub struct Distant {
    requests: Sender<View>,
    pub responses: Receiver<Result<Frame>>,
    pub busy: bool,
}
struct Worker {
    child: Child,
    output: BufReader<std::process::ChildStdout>,
}
impl Worker {
    fn new(source: &WorldSource, restore_coverage: bool) -> Result<Self> {
        let mut child = crate::node_command()
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tools/distant.ts"))
            .arg(&source.root)
            .args(if restore_coverage {
                vec![]
            } else {
                vec!["--skip-coverage"]
            })
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("Start distant terrain adapter")?;
        let output = BufReader::new(child.stdout.take().unwrap());
        Ok(Self { child, output })
    }
    fn build(&mut self, view: View, source: &WorldSource) -> Result<Frame> {
        let input = self.child.stdin.as_mut().context("LOD input closed")?;
        serde_json::to_writer(&mut *input, &view)?;
        writeln!(input)?;
        input.flush()?;
        let mut line = String::new();
        ensure!(self.output.read_line(&mut line)? > 0, "LOD adapter exited");
        let response: serde_json::Value = serde_json::from_str(&line)?;
        ensure!(response["ok"] == true, "LOD adapter: {}", response["error"]);
        let mut frame: Frame = serde_json::from_value(response)?;
        let dir = source
            .root
            .join("distant")
            .join(&source.manifest.source_hash);
        for tile in &mut frame.tiles {
            ensure!(
                std::path::Path::new(&tile.file).components().count() == 1,
                "Invalid LOD filename"
            );
            let bytes = std::fs::read(dir.join(&tile.file))?;
            ensure!(
                tile.format == 2 && bytes.len() == tile.faces * 16 + tile.faces.div_ceil(16) * 48,
                "Truncated LOD tile"
            );
            tile.data = bytes[..tile.faces * 16]
                .as_chunks::<16>()
                .0
                .iter()
                .map(|b| bytemuck::pod_read_unaligned(b))
                .collect();
            tile.visibility = bytes[tile.faces * 16..]
                .as_chunks::<48>()
                .0
                .iter()
                .map(|b| bytemuck::pod_read_unaligned(b))
                .collect();
        }
        Ok(frame)
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Distant {
    pub fn new(source: WorldSource) -> Self {
        let (tx, rx) = bounded::<View>(1);
        let (output, input) = bounded(1);
        std::thread::Builder::new()
            .name("space-distant".into())
            .spawn(move || {
                let mut worker = None;
                let mut restore_coverage = true;
                while let Ok(view) = rx.recv() {
                    let result = (|| {
                        if worker.is_none() {
                            worker = Some(Worker::new(&source, restore_coverage)?);
                            restore_coverage = false;
                        }
                        worker.as_mut().unwrap().build(view, &source)
                    })();
                    // Retain the last published GPU coverage in the caller and
                    // recover a failed adapter on the next bounded retry.
                    if result.is_err() {
                        worker = None;
                    }
                    if output.send(result).is_err() {
                        break;
                    }
                }
            })
            .expect("Start distant worker");
        Self {
            requests: tx,
            responses: input,
            busy: false,
        }
    }
    pub fn request(&mut self, view: View) -> bool {
        if !self.busy && self.requests.try_send(view).is_ok() {
            self.busy = true;
            return true;
        }
        false
    }
}
