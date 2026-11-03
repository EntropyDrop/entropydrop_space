//! Temporary process boundary for the shared Space physics and script runtime.
//! Rust owns the window, renderer, terrain editing and persistence. This adapter
//! can be replaced by native simulation without changing the render interface.
use crate::{
    editor::PlacedEntity,
    geometry::Face,
    protocol,
    world::{Cell, World, color},
};
use anyhow::{Context, Result, ensure};
use crossbeam_channel::{Receiver, Sender, bounded};
use glam::{Mat4, Vec3};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, Stdio},
    thread,
    time::Duration,
};

#[derive(Clone, Serialize)]
pub struct EntityRequest {
    id: String,
    bytes: Vec<u8>,
    position: [f64; 3],
    rotation: [f64; 4],
    running: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Driver {
    pub id: String,
    pub component: String,
    pub seat: usize,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Click {
    pub event_id: String,
    pub entity_id: String,
    pub player_id: String,
    pub node_id: String,
    pub kind: String,
    pub position: [f64; 3],
    pub size: Option<f64>,
    pub decoration_id: Option<String>,
    pub point: [f64; 3],
    pub local_point: [f64; 3],
}
#[derive(Serialize)]
pub struct Request {
    pub epoch: u64,
    pub chunks: Vec<[i32; 2]>,
    pub edits: Vec<(Cell, u32)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entities: Option<Vec<EntityRequest>>,
    pub steps: usize,
    pub down: Vec<String>,
    pub clicks: Vec<Click>,
    pub player: [f64; 3],
    pub driver: Option<Driver>,
}
pub struct Input {
    pub steps: usize,
    pub down: Vec<String>,
    pub clicks: Vec<Click>,
    pub player: [f64; 3],
    pub driver: Option<Driver>,
}
#[derive(Debug, Deserialize)]
pub struct Seat {
    #[serde(default, rename = "fixedOrientation")]
    pub fixed_orientation: bool,
    pub index: usize,
    pub position: [f64; 3],
    pub rotation: [f64; 4],
}
#[derive(Debug, Deserialize)]
pub struct Decoration {
    pub id: String,
    #[serde(default)]
    pub position: Option<[f32; 3]>,
    #[serde(default)]
    pub rotation: Option<[f32; 4]>,
    #[serde(default)]
    pub scale: Option<[f32; 3]>,
    pub color: u32,
    #[serde(default, rename = "materialId")]
    pub material: u32,
}
#[derive(Debug, Deserialize)]
pub struct Node {
    pub id: String,
    pub model: [f32; 16],
    pub voxels: Option<Vec<[f64; 6]>>,
    pub decorations: Vec<Decoration>,
    pub seats: Vec<Seat>,
}
#[derive(Debug, Deserialize)]
pub struct EntityState {
    pub id: String,
    pub nodes: Vec<Node>,
    pub running: bool,
    pub status: String,
    pub error: Option<String>,
    pub logs: Vec<String>,
    pub position: [f64; 3],
    pub velocity: [f64; 3],
}
#[derive(Debug, Deserialize)]
pub struct Frame {
    pub epoch: u64,
    pub entities: Vec<EntityState>,
    pub mutations: Vec<(Cell, u32)>,
}
#[derive(Deserialize)]
struct Envelope {
    ok: bool,
    error: Option<String>,
    #[serde(flatten)]
    frame: Option<Frame>,
}

struct Process {
    child: Child,
    input: ChildStdin,
    output: Receiver<Result<Vec<u8>>>,
}
impl Process {
    fn start(world_dir: &Path) -> Result<Self> {
        let mut child = crate::node_command()
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tools/runtime-worker.ts"
            ))
            .arg(format!("--world-dir={}", world_dir.display()))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("Start shared entity simulation adapter")?;
        let input = child.stdin.take().context("Runtime stdin")?;
        let stdout = child.stdout.take().context("Runtime stdout")?;
        let (tx, output) = bounded(1);
        thread::Builder::new()
            .name("space-runtime-output".into())
            .spawn(move || {
                let mut reader = BufReader::new(stdout);
                loop {
                    let result = (|| -> Result<Vec<u8>> {
                        let mut line = Vec::new();
                        (&mut reader)
                            .take(128 * 1024 * 1024 + 1)
                            .read_until(b'\n', &mut line)?;
                        ensure!(!line.is_empty(), "Entity runtime exited");
                        ensure!(
                            line.len() <= 128 * 1024 * 1024 && line.ends_with(b"\n"),
                            "Runtime response exceeds limit"
                        );
                        Ok(line)
                    })();
                    let failed = result.is_err();
                    if tx.send(result).is_err() || failed {
                        break;
                    }
                }
            })?;
        Ok(Self {
            child,
            input,
            output,
        })
    }
    fn exchange(&mut self, request: &Request) -> Result<Frame> {
        serde_json::to_writer(&mut self.input, request)?;
        self.input.write_all(b"\n")?;
        self.input.flush()?;
        let bytes = self
            .output
            .recv_timeout(Duration::from_secs(30))
            .context("Entity runtime timed out; rendering remains independent")??;
        let envelope: Envelope =
            serde_json::from_slice(&bytes).context("Decode entity runtime reply")?;
        ensure!(
            envelope.ok,
            "Entity runtime: {}",
            envelope.error.unwrap_or_default()
        );
        envelope.frame.context("Entity runtime returned no frame")
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct Runtime {
    requests: Sender<Request>,
    pub responses: Receiver<Result<Frame>>,
    pub busy: bool,
    pub sent_edits: BTreeMap<Cell, u32>,
    sent_revision: Option<u64>,
}
impl Runtime {
    pub fn new(world_dir: &Path) -> Self {
        let (requests, input) = bounded::<Request>(1);
        let (output, responses) = bounded(1);
        let world_dir = world_dir.to_owned();
        thread::Builder::new()
            .name("space-simulation".into())
            .spawn(move || {
                let mut process = None;
                while let Ok(request) = input.recv() {
                    let result = (|| {
                        if process.is_none() {
                            process = Some(Process::start(&world_dir)?);
                        }
                        process.as_mut().unwrap().exchange(&request)
                    })();
                    // A failed worker is discarded; the UI must explicitly restart
                    // it and resend complete authored state, never partial deltas.
                    let failed = result.is_err();
                    if output.send(result).is_err() || failed {
                        break;
                    }
                }
            })
            .expect("start simulation thread");
        Self {
            requests,
            responses,
            busy: false,
            sent_edits: BTreeMap::new(),
            sent_revision: None,
        }
    }
    pub fn submit(
        &mut self,
        world: &World,
        entities: &[PlacedEntity],
        revision: u64,
        input: Input,
    ) -> Result<()> {
        if self.busy {
            return Ok(());
        }
        let definitions = if self.sent_revision != Some(revision) {
            Some(
                entities
                    .iter()
                    .map(|e| -> Result<_> {
                        Ok(EntityRequest {
                            id: e.id.clone(),
                            bytes: protocol::encode(&protocol::inventory::InventoryResource {
                                schema_version: 8,
                                content: Some(
                                    protocol::inventory::inventory_resource::Content::Entity(
                                        e.definition.clone(),
                                    ),
                                ),
                            })?,
                            position: e.position,
                            rotation: e.rotation,
                            running: e.running,
                        })
                    })
                    .collect::<Result<Vec<_>>>()?,
            )
        } else {
            None
        };
        let edits = world
            .edits
            .iter()
            .filter(|(c, v)| self.sent_edits.get(c) != Some(v))
            .map(|(c, v)| (*c, *v))
            .collect();
        self.requests
            .try_send(Request {
                epoch: revision,
                chunks: world.chunks.keys().map(|k| [k.0, k.1]).collect(),
                edits,
                entities: definitions,
                steps: input.steps,
                down: input.down,
                clicks: input.clicks,
                player: input.player,
                driver: input.driver,
            })
            .context("Send entity runtime frame")?;
        self.sent_revision = Some(revision);
        self.sent_edits.clone_from(&world.edits);
        self.busy = true;
        Ok(())
    }
}

/// Expand only exposed voxel faces; geometry stays resident while poses change.
pub fn voxel_faces(voxels: &[[f64; 6]]) -> Vec<Face> {
    let mut cells = BTreeMap::new();
    for v in voxels {
        let p = [
            (v[0] * 8.0).round() as i32,
            (v[1] * 8.0).round() as i32,
            (v[2] * 8.0).round() as i32,
        ];
        let size = (v[3] * 8.0).round() as i32;
        if size != 1 && size != 8 {
            continue;
        }
        cells.insert((p, size), color(v[4] as u32, v[5] as u32));
    }
    let mut faces = Vec::new();
    for ((p, size), value) in &cells {
        for axis in 0..6 {
            let d = axis / 2;
            let mut neighbor = *p;
            neighbor[d] += if axis % 2 == 1 { *size } else { -*size };
            if cells
                .get(&(neighbor, *size))
                .is_some_and(|other| (*other >> 24) <= 2 || other == value)
            {
                continue;
            }
            let mut origin = Vec3::new(p[0] as f32, p[1] as f32, p[2] as f32) * 0.125;
            if axis % 2 == 1 {
                origin[d] += *size as f32 * 0.125;
            }
            faces.push(Face {
                origin: origin.to_array(),
                color: *value,
                extent: [*size as f32 * 0.125; 2],
                axis: axis as u32,
                padding: 0,
            });
        }
    }
    faces
}
pub fn decoration_mesh(d: &Decoration, parent: Mat4) -> (Vec<Face>, Mat4) {
    let mut faces = voxel_faces(&[[-0.5, -0.5, -0.5, 1.0, d.color as f64, d.material as f64]]);
    // Decorations are centered cubes, not construction-grid voxels.
    for f in &mut faces {
        f.origin = Vec3::from_array(f.origin).to_array();
    }
    let model = parent
        * Mat4::from_scale_rotation_translation(
            Vec3::from_array(d.scale.unwrap_or([1.0; 3])),
            glam::Quat::from_array(d.rotation.unwrap_or([0.0, 0.0, 0.0, 1.0])),
            Vec3::from_array(d.position.unwrap_or([0.0; 3])),
        );
    (faces, model)
}
