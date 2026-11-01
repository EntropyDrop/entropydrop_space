use crate::geometry::{self, Face, WORLD_X, WORLD_Z};
use anyhow::{Context, Result, ensure};
use glam::{DVec3, Vec3};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

pub const CHUNK_CELLS: usize = 16 * 256 * 16;
pub fn index(x: usize, y: usize, z: usize) -> usize {
    (y * 16 + z) * 16 + x
}
pub fn color(rgb: u32, material: u32) -> u32 {
    (rgb & 0xffffff) | ((material.min(101) + 1) << 24)
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Cell {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub micro: bool,
}
impl Cell {
    pub fn new(x: i32, y: i32, z: i32, micro: bool) -> Self {
        let s = if micro { 8 } else { 1 };
        Self {
            x: x.rem_euclid(WORLD_X * s),
            y,
            z: z.rem_euclid(WORLD_Z * s),
            micro,
        }
    }
    pub fn position(self) -> DVec3 {
        DVec3::new(self.x as f64, self.y as f64, self.z as f64) * self.scale()
    }
    pub fn scale(self) -> f64 {
        if self.micro { 0.125 } else { 1.0 }
    }
    pub fn chunk(self) -> (i32, i32) {
        let n = if self.micro { 128 } else { 16 };
        (self.x.div_euclid(n), self.z.div_euclid(n))
    }
}
#[derive(Clone)]
pub struct Chunk {
    pub cells: Vec<u32>,
    pub micro: BTreeMap<[i32; 3], u32>,
}
impl Chunk {
    pub fn empty() -> Self {
        Self {
            cells: vec![0; CHUNK_CELLS],
            micro: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub schema: u32,
    pub world: String,
    pub seed: i64,
    pub generator: u32,
    pub spawn: [f64; 3],
    #[serde(default)]
    pub source_hash: String,
}
#[derive(Clone)]
pub struct WorldSource {
    pub root: PathBuf,
    pub manifest: Manifest,
}
impl WorldSource {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        let manifest: Manifest = serde_json::from_slice(&fs::read(root.join("manifest.json"))?)?;
        ensure!(manifest.schema == 1, "Unsupported native world data schema");
        Ok(Self { root, manifest })
    }
    pub fn load(&self, key: (i32, i32)) -> Result<Chunk> {
        let path = self
            .root
            .join("chunks")
            .join(format!("{}_{}.bin.gz", key.0, key.1));
        let file = fs::File::open(&path).with_context(|| {
            format!(
                "Missing world chunk {}:{}; prepare additional terrain data",
                key.0, key.1
            )
        })?;
        let mut data = Vec::new();
        flate2::read::GzDecoder::new(file)
            .take(32 * 1024 * 1024 + 1)
            .read_to_end(&mut data)?;
        ensure!(
            data.len() >= 16 + CHUNK_CELLS * 4 && data.len() <= 32 * 1024 * 1024,
            "Invalid chunk length"
        );
        ensure!(&data[..4] == b"SPC1", "Invalid chunk header");
        let read = |i: usize| u32::from_le_bytes(data[i..i + 4].try_into().unwrap());
        ensure!(
            read(4) == key.0 as u32 && read(8) == key.1 as u32,
            "Chunk coordinate mismatch"
        );
        let count = read(12) as usize;
        let base = 16 + CHUNK_CELLS * 4;
        ensure!(
            data.len() == base + count * 16,
            "Invalid micro record count"
        );
        let cells = (0..CHUNK_CELLS).map(|i| read(16 + i * 4)).collect();
        let mut micro = BTreeMap::new();
        for i in 0..count {
            let n = base + i * 16;
            let p = [read(n) as i32, read(n + 4) as i32, read(n + 8) as i32];
            ensure!(
                (0..128).contains(&p[0]) && (0..2048).contains(&p[1]) && (0..128).contains(&p[2]),
                "Micro cell out of bounds"
            );
            micro.insert(p, read(n + 12));
        }
        Ok(Chunk { cells, micro })
    }
    pub fn available(&self, key: (i32, i32)) -> bool {
        self.root
            .join("chunks")
            .join(format!("{}_{}.bin.gz", key.0, key.1))
            .is_file()
    }
}

pub struct World {
    pub source: WorldSource,
    pub chunks: HashMap<(i32, i32), Arc<Chunk>>,
    pub edits: BTreeMap<Cell, u32>,
    pub dirty: HashSet<(i32, i32)>,
    pub revision: u64,
}
impl World {
    pub fn new(source: WorldSource) -> Self {
        Self {
            source,
            chunks: HashMap::new(),
            edits: BTreeMap::new(),
            dirty: HashSet::new(),
            revision: 0,
        }
    }
    pub fn insert(&mut self, key: (i32, i32), mut chunk: Chunk) {
        for (cell, value) in &self.edits {
            if cell.chunk() == key {
                Self::set_in_chunk(&mut chunk, *cell, *value);
            }
        }
        self.chunks.insert(key, Arc::new(chunk));
        self.mark_dirty(key);
    }
    pub fn mark_dirty(&mut self, key: (i32, i32)) {
        self.dirty.insert(key);
        for (dx, dz) in [(-1, 0), (1, 0), (0, -1), (0, 1)] {
            self.dirty
                .insert(((key.0 + dx).rem_euclid(1024), (key.1 + dz).rem_euclid(128)));
        }
        self.revision += 1;
    }
    fn set_in_chunk(chunk: &mut Chunk, cell: Cell, value: u32) {
        if cell.micro {
            let key = [cell.x.rem_euclid(128), cell.y, cell.z.rem_euclid(128)];
            if value == 0 {
                chunk.micro.remove(&key);
            } else {
                chunk.micro.insert(key, value);
            }
        } else if (0..256).contains(&cell.y) {
            chunk.cells[index(
                cell.x.rem_euclid(16) as usize,
                cell.y as usize,
                cell.z.rem_euclid(16) as usize,
            )] = value;
        }
    }
    pub fn get(&self, cell: Cell) -> u32 {
        if let Some(value) = self.edits.get(&cell) {
            return *value;
        }
        let Some(chunk) = self.chunks.get(&cell.chunk()) else {
            return 0;
        };
        if cell.micro {
            *chunk
                .micro
                .get(&[cell.x.rem_euclid(128), cell.y, cell.z.rem_euclid(128)])
                .unwrap_or(&0)
        } else if (0..256).contains(&cell.y) {
            chunk.cells[index(
                cell.x.rem_euclid(16) as usize,
                cell.y as usize,
                cell.z.rem_euclid(16) as usize,
            )]
        } else {
            0
        }
    }
    pub fn set(&mut self, cell: Cell, value: u32) -> u32 {
        let cell = Cell::new(cell.x, cell.y, cell.z, cell.micro);
        let old = self.get(cell);
        if old != value {
            self.edits.insert(cell, value);
            if let Some(chunk) = self.chunks.get_mut(&cell.chunk()) {
                Self::set_in_chunk(Arc::make_mut(chunk), cell, value);
            }
            self.mark_dirty(cell.chunk());
        }
        old
    }
    pub fn solid_at(&self, p: DVec3) -> bool {
        self.get(Cell::new(
            p.x.floor() as i32,
            p.y.floor() as i32,
            p.z.floor() as i32,
            false,
        )) != 0
            || self.get(Cell::new(
                (p.x * 8.0).floor() as i32,
                (p.y * 8.0).floor() as i32,
                (p.z * 8.0).floor() as i32,
                true,
            )) != 0
    }
    pub fn raycast(&self, origin: DVec3, direction: DVec3, range: f64) -> Option<Hit> {
        let dir = direction.normalize_or_zero();
        if dir.length_squared() < 0.5 {
            return None;
        }
        // Traverse exact eighth-unit cells. Full cells are tested in the same traversal.
        let p = origin * 8.0;
        let mut c = p.floor().as_ivec3();
        let step = dir.signum().as_ivec3();
        let delta = DVec3::ONE / dir.abs();
        let boundary = c.as_dvec3()
            + DVec3::new(
                if dir.x > 0.0 { 1.0 } else { 0.0 },
                if dir.y > 0.0 { 1.0 } else { 0.0 },
                if dir.z > 0.0 { 1.0 } else { 0.0 },
            );
        let mut t = (boundary - p) / dir;
        for d in 0..3 {
            if dir[d].abs() < 1e-12 {
                t[d] = f64::INFINITY;
            }
        }
        let mut distance = 0.0;
        let mut normal = DVec3::ZERO;
        for _ in 0..8192 {
            let full = Cell::new(
                c.x.div_euclid(8),
                c.y.div_euclid(8),
                c.z.div_euclid(8),
                false,
            );
            let micro = Cell::new(c.x, c.y, c.z, true);
            let cell = if self.get(full) != 0 {
                Some(full)
            } else if self.get(micro) != 0 {
                Some(micro)
            } else {
                None
            };
            if let Some(cell) = cell {
                return Some(Hit {
                    cell,
                    distance: distance / 8.0,
                    normal,
                    point: origin + dir * (distance / 8.0),
                });
            }
            let axis = if t.x <= t.y && t.x <= t.z {
                0
            } else if t.y <= t.z {
                1
            } else {
                2
            };
            distance = t[axis];
            if distance > range * 8.0 {
                return None;
            }
            c[axis] += step[axis];
            t[axis] += delta[axis];
            normal = DVec3::ZERO;
            normal[axis] = -(step[axis] as f64);
        }
        None
    }
    pub fn mesh(&self, key: (i32, i32)) -> Vec<Face> {
        let Some(chunk) = self.chunks.get(&key) else {
            return Vec::new();
        };
        let ox = key.0 * 16;
        let oz = key.1 * 16;
        let mut faces = geometry::greedy_mesh(
            [16, 256, 16],
            Vec3::new(ox as f32, 0.0, oz as f32),
            1.0,
            |x, y, z| self.get(Cell::new(ox + x, y, oz + z, false)),
        );
        // Meshing sparse 2m micro partitions avoids a dense 128x2048x128 volume.
        let mut partitions = HashSet::new();
        for p in chunk.micro.keys() {
            partitions.insert([
                p[0].div_euclid(16),
                p[1].div_euclid(16),
                p[2].div_euclid(16),
            ]);
        }
        for part in partitions {
            let mx = ox * 8 + part[0] * 16;
            let my = part[1] * 16;
            let mz = oz * 8 + part[2] * 16;
            let mut m = geometry::greedy_mesh(
                [16, 16, 16],
                Vec3::new(mx as f32, my as f32, mz as f32) * 0.125,
                0.125,
                |x, y, z| {
                    let micro = Cell::new(mx + x, my + y, mz + z, true);
                    let full = Cell::new(
                        (mx + x).div_euclid(8),
                        (my + y).div_euclid(8),
                        (mz + z).div_euclid(8),
                        false,
                    );
                    if self.get(full) != 0 {
                        0x00ffffff
                    } else {
                        self.get(micro)
                    }
                },
            );
            // The partition mesher must not emit full terrain again.
            // A reserved material prevents merging terrain faces with micro
            // faces of the same color across a partition boundary.
            m.retain(|f| f.color != 0x00ffffff);
            faces.extend(m);
        }
        faces
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Hit {
    pub cell: Cell,
    pub distance: f64,
    pub normal: DVec3,
    pub point: DVec3,
}
