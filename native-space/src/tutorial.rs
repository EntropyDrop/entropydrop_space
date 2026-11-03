//! Baked Web tutorial content. Loading and navigation are owned by Rust.
use crate::{
    camera::Camera,
    editor::{Editor, PlacedEntity},
    protocol,
    world::{Cell, World, color},
};
use anyhow::{Context, Result};
use glam::DVec3;
use serde::Deserialize;
#[derive(Deserialize)]
struct Spawn {
    x_cm: i32,
    y_cm: i32,
    z_cm: i32,
    yaw_q15: i32,
    pitch_q15: i32,
}
#[derive(Deserialize)]
struct Terrain {
    standard: Vec<Vec<i64>>,
    micro: Vec<Vec<i64>>,
}
#[derive(Deserialize)]
struct Entity {
    id: String,
    position: [f64; 3],
    rotation: [f64; 4],
    file: String,
}
#[derive(Deserialize)]
struct Level {
    spawn: Spawn,
    terrain: Terrain,
    entities: Vec<Entity>,
}
pub fn load(world: &mut World, editor: &mut Editor, camera: &mut Camera) -> Result<()> {
    let level: Level = serde_json::from_str(include_str!("../assets/tutorial/level.json"))?;
    for row in level.terrain.standard {
        anyhow::ensure!(row.len() >= 5, "Invalid tutorial cell");
        world.edits.insert(
            Cell::new(row[0] as i32, row[1] as i32, row[2] as i32, false),
            if row[3] == 0 {
                0
            } else {
                color(row[4] as u32, row.get(5).copied().unwrap_or(0) as u32)
            },
        );
    }
    for row in level.terrain.micro {
        anyhow::ensure!(row.len() >= 4, "Invalid tutorial micro cell");
        world.edits.insert(
            Cell::new(row[0] as i32, row[1] as i32, row[2] as i32, true),
            if row[3] < 0 {
                0
            } else {
                color(row[3] as u32, row.get(4).copied().unwrap_or(0) as u32)
            },
        );
    }
    for e in level.entities {
        let bytes: &[u8] = match e.file.as_str() {
            "tutorial-chassis.edpb" => include_bytes!("../assets/tutorial/tutorial-chassis.edpb"),
            "tutorial-modeling-example.edpb" => {
                include_bytes!("../assets/tutorial/tutorial-modeling-example.edpb")
            }
            _ => anyhow::bail!("Unknown tutorial entity"),
        };
        let resource = protocol::decode(bytes)?;
        let Some(protocol::inventory::inventory_resource::Content::Entity(definition)) =
            resource.content
        else {
            anyhow::bail!("Invalid tutorial entity")
        };
        let mut placed = PlacedEntity::new(definition, DVec3::from_array(e.position));
        placed.id = e.id;
        placed.rotation = e.rotation;
        placed.running = false;
        editor.entities.push(placed);
    }
    camera.position = DVec3::new(
        level.spawn.x_cm as f64 / 100.0,
        level.spawn.y_cm as f64 / 100.0 + 1.65,
        level.spawn.z_cm as f64 / 100.0,
    );
    camera.yaw = level.spawn.yaw_q15 as f64 / 32767.0 * std::f64::consts::PI;
    camera.pitch = level.spawn.pitch_q15 as f64 / 32767.0 * std::f64::consts::PI;
    camera.flying = false;
    world.revision = world.revision.checked_add(1).context("Revision overflow")?;
    Ok(())
}
pub fn lesson_position(chapter: usize) -> DVec3 {
    let n = chapter.clamp(1, 13);
    let gaps = usize::from(n >= 10) + usize::from(n >= 11);
    let extra = usize::from(n >= 12) + usize::from(n >= 13);
    DVec3::new(
        65420.0 / 8.0 + (n - 1 + extra) as f64 * (-158.0 / 8.0) - 5.0 * gaps as f64,
        19.0,
        4568.0 / 8.0 + (n - 1 + extra) as f64 * 27.0 / 8.0 + gaps as f64,
    )
}
