use crate::{
    protocol::{self, inventory as pb},
    world::{Cell, World, color},
};
use anyhow::{Result, ensure};
use glam::{DQuat, DVec3};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tool {
    Build,
    Erase,
    Paint,
    Select,
    Pick,
}
#[derive(Clone, Copy)]
pub enum SelectionAction {
    Fill,
    Paint,
    Erase,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Change {
    pub cell: Cell,
    pub before: u32,
    pub after: u32,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct PlacedEntity {
    pub id: String,
    pub definition: pb::Entity,
    pub position: [f64; 3],
    pub rotation: [f64; 4],
    pub running: bool,
    pub velocity: [f64; 3],
}
impl PlacedEntity {
    pub fn new(definition: pb::Entity, position: DVec3) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            definition,
            position: position.to_array(),
            rotation: DQuat::IDENTITY.to_array(),
            running: false,
            velocity: [0.0; 3],
        }
    }
    pub fn name(&self) -> &str {
        self.definition.root.as_ref().map_or("Entity", |c| {
            if c.name.is_empty() {
                c.id.as_str()
            } else {
                c.name.as_str()
            }
        })
    }
}

pub struct Editor {
    pub tool: Tool,
    pub micro: bool,
    pub rgb: u32,
    pub material: u32,
    pub brush: i32,
    pub selection: Option<(Cell, Cell)>,
    pub clipboard: Option<pb::InventoryResource>,
    pub undo: Vec<Vec<Change>>,
    pub redo: Vec<Vec<Change>>,
    pub backpack: Vec<pb::InventoryResource>,
    pub entities: Vec<PlacedEntity>,
    pub selected_entity: Option<usize>,
    pub revision: u64,
    stroke: Option<Vec<Change>>,
}
impl Default for Editor {
    fn default() -> Self {
        Self {
            tool: Tool::Build,
            micro: false,
            rgb: 0xf2a93b,
            material: 0,
            brush: 1,
            selection: None,
            clipboard: None,
            undo: Vec::new(),
            redo: Vec::new(),
            backpack: Vec::new(),
            entities: Vec::new(),
            selected_entity: None,
            revision: 0,
            stroke: None,
        }
    }
}
impl Editor {
    pub fn begin_stroke(&mut self) {
        self.end_stroke();
        self.stroke = Some(Vec::new());
    }
    pub fn end_stroke(&mut self) {
        if let Some(batch) = self.stroke.take().filter(|b| !b.is_empty()) {
            self.undo.push(batch);
            if self.undo.len() > 128 {
                self.undo.remove(0);
            }
        }
    }
    pub fn edit(&mut self, world: &mut World, changes: impl IntoIterator<Item = (Cell, u32)>) {
        let mut batch = Vec::new();
        for (cell, after) in changes {
            if cell.y < 0
                || cell.y >= if cell.micro { 2048 } else { 256 }
                || !world.chunks.contains_key(&cell.chunk())
            {
                continue;
            }
            if cell.micro {
                let parent = Cell::new(
                    cell.x.div_euclid(8),
                    cell.y.div_euclid(8),
                    cell.z.div_euclid(8),
                    false,
                );
                if after != 0 && world.get(parent) != 0 {
                    continue;
                }
            } else {
                // Standard edits suppress generated micro detail, including an
                // explicit AIR edit. Record every removed cell for exact undo.
                let micros: Vec<Cell> = world.chunks[&cell.chunk()]
                    .micro
                    .keys()
                    .filter_map(|p| {
                        let m = Cell::new(
                            cell.chunk().0 * 128 + p[0],
                            p[1],
                            cell.chunk().1 * 128 + p[2],
                            true,
                        );
                        (m.x.div_euclid(8) == cell.x
                            && m.y.div_euclid(8) == cell.y
                            && m.z.div_euclid(8) == cell.z)
                            .then_some(m)
                    })
                    .collect();
                for m in micros {
                    let before = world.set(m, 0);
                    if before != 0 {
                        batch.push(Change {
                            cell: m,
                            before,
                            after: 0,
                        });
                    }
                }
            }
            let before = world.set(cell, after);
            if before != after {
                batch.push(Change {
                    cell,
                    before,
                    after,
                });
            }
        }
        if !batch.is_empty() {
            if let Some(stroke) = &mut self.stroke {
                stroke.extend(batch);
            } else {
                self.undo.push(batch);
            }
            if self.undo.len() > 128 {
                self.undo.remove(0);
            }
            self.redo.clear();
            self.revision += 1;
        }
    }
    pub fn undo(&mut self, world: &mut World) {
        self.end_stroke();
        if let Some(batch) = self.undo.pop() {
            for c in batch.iter().rev() {
                world.set(c.cell, c.before);
            }
            self.redo.push(batch);
            self.revision += 1;
        }
    }
    pub fn redo(&mut self, world: &mut World) {
        self.end_stroke();
        if let Some(batch) = self.redo.pop() {
            for c in &batch {
                world.set(c.cell, c.after);
            }
            self.undo.push(batch);
            self.revision += 1;
        }
    }
    pub fn apply_hit(&mut self, world: &mut World, hit: crate::world::Hit, secondary: bool) {
        let tool = if secondary { Tool::Erase } else { self.tool };
        if tool == Tool::Pick {
            let value = world.get(hit.cell);
            self.rgb = value & 0xffffff;
            self.material = (value >> 24).saturating_sub(1);
            return;
        }
        if tool == Tool::Select {
            self.selection = match self.selection {
                Some((first, _)) => Some((first, hit.cell)),
                None => Some((hit.cell, hit.cell)),
            };
            return;
        }
        let micro = if tool == Tool::Erase || tool == Tool::Paint {
            hit.cell.micro
        } else {
            self.micro
        };
        let scale = if micro { 8.0 } else { 1.0 };
        let p = if tool == Tool::Build {
            hit.point + hit.normal * 0.002
        } else {
            hit.point - hit.normal * 0.002
        };
        let p = (p * scale).floor().as_ivec3();
        let mut changes = Vec::new();
        for z in 0..self.brush {
            for y in 0..self.brush {
                for x in 0..self.brush {
                    let cell = Cell::new(p.x + x, p.y + y, p.z + z, micro);
                    if tool == Tool::Paint && world.get(cell) == 0 {
                        continue;
                    }
                    changes.push((
                        cell,
                        if tool == Tool::Erase {
                            0
                        } else {
                            color(self.rgb, self.material)
                        },
                    ));
                }
            }
        }
        self.edit(world, changes);
    }
    pub fn copy_selection(&mut self, world: &World) -> Result<()> {
        let (a, b) = self
            .selection
            .ok_or_else(|| anyhow::anyhow!("Select two corners first"))?;
        ensure!(
            a.micro == b.micro,
            "Selection corners must use the same grid"
        );
        let pa = a.position();
        let mut pb = b.position();
        pb.x = crate::geometry::wrap_near(pb.x, pa.x, 16384.0);
        pb.z = crate::geometry::wrap_near(pb.z, pa.z, 2048.0);
        let min = pa.min(pb);
        let max = pa.max(pb) + DVec3::splat(a.scale());
        ensure!(
            (max - min).element_product() <= 262144.0,
            "Selection is too large"
        );
        Self::require_loaded(world, min, max)?;
        let mut voxels = Vec::new();
        let origin = min.floor();
        for (key, chunk) in &world.chunks {
            for y in min.y.floor().max(0.0) as i32..max.y.ceil().min(256.0) as i32 {
                for z in 0..16 {
                    for x in 0..16 {
                        let cell = Cell::new(key.0 * 16 + x, y, key.1 * 16 + z, false);
                        let mut p = cell.position();
                        p.x = crate::geometry::wrap_near(p.x, min.x, 16384.0);
                        p.z = crate::geometry::wrap_near(p.z, min.z, 2048.0);
                        if p.cmpge(min).all() && p.cmplt(max).all() {
                            let v = world.get(cell);
                            if v != 0 {
                                voxels.push(voxel_at(p, cell.micro, v, origin));
                            }
                        }
                    }
                }
            }
            for p in chunk.micro.keys() {
                let cell = Cell::new(key.0 * 128 + p[0], p[1], key.1 * 128 + p[2], true);
                let mut at = cell.position();
                at.x = crate::geometry::wrap_near(at.x, min.x, 16384.0);
                at.z = crate::geometry::wrap_near(at.z, min.z, 2048.0);
                if at.cmpge(min).all() && at.cmplt(max).all() {
                    voxels.push(voxel_at(at, cell.micro, world.get(cell), origin));
                }
            }
        }
        ensure!(!voxels.is_empty(), "Selection contains no voxels");
        ensure!(voxels.len() <= 65536, "Selection exceeds 65,536 voxels");
        self.clipboard = Some(pb::InventoryResource {
            schema_version: 8,
            content: Some(pb::inventory_resource::Content::BlockSet(pb::BlockSet {
                name: "Selection".into(),
                blocks: voxels,
            })),
        });
        Ok(())
    }
    fn require_loaded(world: &World, min: DVec3, max: DVec3) -> Result<()> {
        for z in (min.z / 16.0).floor() as i32..=((max.z - 0.001) / 16.0).floor() as i32 {
            for x in (min.x / 16.0).floor() as i32..=((max.x - 0.001) / 16.0).floor() as i32 {
                ensure!(
                    world
                        .chunks
                        .contains_key(&(x.rem_euclid(1024), z.rem_euclid(128))),
                    "Selection crosses unloaded terrain; move closer before editing"
                );
            }
        }
        Ok(())
    }
    pub fn change_selection(&mut self, world: &mut World, action: SelectionAction) -> Result<()> {
        let (a, b) = self
            .selection
            .ok_or_else(|| anyhow::anyhow!("Select two corners first"))?;
        ensure!(
            a.micro == b.micro,
            "Selection corners must use the same grid"
        );
        let scale = if a.micro { 8.0 } else { 1.0 };
        let pa = a.position();
        let mut pb = b.position();
        pb.x = crate::geometry::wrap_near(pb.x, pa.x, 16384.0);
        pb.z = crate::geometry::wrap_near(pb.z, pa.z, 2048.0);
        let min = pa.min(pb);
        let max = pa.max(pb) + DVec3::splat(a.scale());
        Self::require_loaded(world, min, max)?;
        let size = ((max - min) * scale).round().as_ivec3();
        ensure!(
            (size.x as i64) * (size.y as i64) * (size.z as i64) <= 65536,
            "Selection edit exceeds 65,536 cells"
        );
        let start = (min * scale).round().as_ivec3();
        let mut changes = Vec::new();
        for z in 0..size.z {
            for y in 0..size.y {
                for x in 0..size.x {
                    let cell = Cell::new(start.x + x, start.y + y, start.z + z, a.micro);
                    if matches!(action, SelectionAction::Paint) && world.get(cell) == 0 {
                        continue;
                    }
                    changes.push((
                        cell,
                        if matches!(action, SelectionAction::Erase) {
                            0
                        } else {
                            color(self.rgb, self.material)
                        },
                    ));
                }
            }
        }
        self.edit(world, changes);
        Ok(())
    }
    pub fn cut_selection(&mut self, world: &mut World) -> Result<()> {
        self.copy_selection(world)?;
        self.change_selection(world, SelectionAction::Erase)
    }
    pub fn rotate_clipboard(&mut self) -> Result<()> {
        let Some(pb::inventory_resource::Content::BlockSet(b)) =
            self.clipboard.as_mut().and_then(|r| r.content.as_mut())
        else {
            anyhow::bail!(
                "Copy a block selection to rotate it; entities rotate in the Entities panel"
            );
        };
        for v in &mut b.blocks {
            let s = if v.is_micro { 1 } else { 8 };
            let x = v.dx * 8 + if v.is_micro { v.micro_x as i32 } else { 0 };
            let z = v.dz * 8 + if v.is_micro { v.micro_z as i32 } else { 0 };
            let nx = -z - s;
            v.dx = nx.div_euclid(8);
            v.dz = x.div_euclid(8);
            if v.is_micro {
                v.micro_x = nx.rem_euclid(8) as u32;
                v.micro_z = x.rem_euclid(8) as u32;
            }
        }
        Ok(())
    }
    pub fn paste(&mut self, world: &mut World, position: DVec3) -> Result<()> {
        let resource = self
            .clipboard
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Clipboard is empty"))?;
        self.place(world, &resource, position)
    }
    pub fn place(
        &mut self,
        world: &mut World,
        r: &pb::InventoryResource,
        position: DVec3,
    ) -> Result<()> {
        protocol::validate(r)?;
        let p = position;
        use pb::inventory_resource::Content;
        match r.content.as_ref().unwrap() {
            Content::BlockSet(b) => self.place_blocks(world, &b.blocks, p)?,
            Content::Entity(e) => {
                self.entities.push(PlacedEntity::new(e.clone(), p));
                self.revision += 1;
            }
            Content::Item(i) => {
                if let Some(b) = &i.block_set {
                    self.place_blocks(world, &b.blocks, p)?;
                }
                for e in &i.entity_list {
                    let mut definition = e.clone();
                    let mut offset = DVec3::ZERO;
                    let mut rotation = DQuat::IDENTITY;
                    if let Some(root) = &mut definition.root {
                        if let Some(v) = root.local_position.take() {
                            offset = DVec3::new(v.x, v.y, v.z);
                        }
                        if let Some(q) = root.local_rotation.take() {
                            rotation = DQuat::from_xyzw(q.x, q.y, q.z, q.w);
                        }
                    }
                    for j in &mut definition.constraints {
                        if j.body_a_component_id.is_none()
                            && let Some(a) = &mut j.anchor_a
                        {
                            a.x += p.x;
                            a.y += p.y;
                            a.z += p.z;
                        }
                    }
                    let mut placed = PlacedEntity::new(definition, p + offset);
                    placed.rotation = rotation.to_array();
                    self.entities.push(placed);
                }
                self.revision += 1;
            }
            Content::ColorSet(c) => {
                if let Some(e) = c.entries.first()
                    && let Some(s) = e.stops.first()
                {
                    self.rgb = s.color_rgb;
                    self.material = e.material_id;
                }
            }
        }
        Ok(())
    }
    fn place_blocks(&mut self, world: &mut World, blocks: &[pb::Voxel], p: DVec3) -> Result<()> {
        for v in blocks {
            let s = if v.is_micro { 8 } else { 1 };
            let cell = Cell::new(
                (p.x * s as f64).floor() as i32
                    + v.dx * s
                    + if v.is_micro { v.micro_x as i32 } else { 0 },
                (p.y * s as f64).floor() as i32
                    + v.dy * s
                    + if v.is_micro { v.micro_y as i32 } else { 0 },
                (p.z * s as f64).floor() as i32
                    + v.dz * s
                    + if v.is_micro { v.micro_z as i32 } else { 0 },
                v.is_micro,
            );
            ensure!(
                world.chunks.contains_key(&cell.chunk()) && (0..256 * s).contains(&cell.y),
                "Paste crosses unloaded terrain or world height limits"
            );
        }
        self.edit(
            world,
            blocks.iter().map(|v| {
                let s = if v.is_micro { 8 } else { 1 };
                (
                    Cell::new(
                        (p.x * s as f64).floor() as i32
                            + v.dx * s
                            + if v.is_micro { v.micro_x as i32 } else { 0 },
                        (p.y * s as f64).floor() as i32
                            + v.dy * s
                            + if v.is_micro { v.micro_y as i32 } else { 0 },
                        (p.z * s as f64).floor() as i32
                            + v.dz * s
                            + if v.is_micro { v.micro_z as i32 } else { 0 },
                        v.is_micro,
                    ),
                    color(v.color_rgb, v.material_id),
                )
            }),
        );
        Ok(())
    }
    pub fn entityize(&mut self, world: &World) -> Result<()> {
        self.copy_selection(world)?;
        let Some(pb::inventory_resource::Content::BlockSet(b)) =
            self.clipboard.as_ref().and_then(|c| c.content.as_ref())
        else {
            unreachable!()
        };
        let root = pb::Component {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Entity".into(),
            blocks: b.blocks.clone(),
            script_language: "assemblyscript".into(),
            body: Some(pb::BodyConfig {
                r#type: 1,
                ..Default::default()
            }),
            ..Default::default()
        };
        self.clipboard = Some(pb::InventoryResource {
            schema_version: 8,
            content: Some(pb::inventory_resource::Content::Entity(pb::Entity {
                root: Some(root),
                constraints: Vec::new(),
            })),
        });
        Ok(())
    }
}
fn voxel_at(position: DVec3, micro_cell: bool, value: u32, origin: DVec3) -> pb::Voxel {
    let p = position - origin;
    let base = p.floor();
    let micro = ((p - base) * 8.0).round();
    pb::Voxel {
        dx: base.x as i32,
        dy: base.y as i32,
        dz: base.z as i32,
        is_micro: micro_cell,
        micro_x: if micro_cell { micro.x as u32 } else { 0 },
        micro_y: if micro_cell { micro.y as u32 } else { 0 },
        micro_z: if micro_cell { micro.z as u32 } else { 0 },
        color_rgb: value & 0xffffff,
        material_id: (value >> 24).saturating_sub(1),
    }
}
