use crate::{editor::PlacedEntity, protocol::inventory, world::Cell};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

#[derive(Default, Clone, Serialize, Deserialize)]
pub struct Save {
    pub schema: u32,
    pub world: String,
    pub source_hash: String,
    pub position: [f64; 3],
    pub yaw: f64,
    pub pitch: f64,
    pub edits: Vec<(Cell, u32)>,
    pub entities: Vec<PlacedEntity>,
    pub backpack: Vec<inventory::InventoryResource>,
    #[serde(default)]
    pub perspective: u8,
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path)?;
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
pub fn save(path: &Path, value: &Save) -> Result<()> {
    let json = serde_json::to_vec(value)?;
    let mut zip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    zip.write_all(&json)?;
    atomic_write(path, &zip.finish()?)
}
pub fn load(path: &Path, world: &str, source_hash: &str) -> Result<Save> {
    let file = File::open(path)?;
    let mut json = Vec::new();
    flate2::read::GzDecoder::new(file)
        .take(128 * 1024 * 1024 + 1)
        .read_to_end(&mut json)?;
    ensure!(json.len() <= 128 * 1024 * 1024, "Save exceeds size limit");
    let value: Save = serde_json::from_slice(&json)?;
    ensure!(
        value.schema == 1 && value.world == world,
        "Save belongs to a different world or schema"
    );
    ensure!(
        value.source_hash == source_hash,
        "Terrain source changed; preserve this save and explicitly migrate before loading"
    );
    ensure!(
        value.position.iter().all(|n| n.is_finite())
            && value.yaw.is_finite()
            && value.pitch.is_finite(),
        "Invalid saved camera"
    );
    ensure!(
        value.edits.len() <= 2_000_000
            && value.entities.len() <= 4096
            && value.backpack.len() <= 4096,
        "Save exceeds object limits"
    );
    for e in &value.entities {
        crate::protocol::validate_entity(&e.definition)?;
        ensure!(
            e.position
                .iter()
                .chain(e.rotation.iter())
                .chain(e.velocity.iter())
                .all(|v| v.is_finite()),
            "Invalid saved entity transform"
        );
        ensure!(
            (e.rotation.iter().map(|v| v * v).sum::<f64>() - 1.0).abs() < 1e-6,
            "Invalid saved entity rotation"
        );
    }
    let mut cells = std::collections::HashSet::new();
    for (cell, packed) in &value.edits {
        ensure!(
            *cell == Cell::new(cell.x, cell.y, cell.z, cell.micro)
                && cell.y >= 0
                && cell.y < if cell.micro { 2048 } else { 256 },
            "Invalid saved cell coordinate"
        );
        ensure!(
            *packed == 0 || (1..=102).contains(&(packed >> 24)),
            "Invalid saved material"
        );
        ensure!(cells.insert(*cell), "Duplicate saved cell");
    }
    for r in &value.backpack {
        crate::protocol::validate(r)?;
    }
    Ok(value)
}
