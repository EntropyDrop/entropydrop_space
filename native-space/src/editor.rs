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
pub struct EntityChange {
    pub index: usize,
    pub before: Option<PlacedEntity>,
    pub after: Option<PlacedEntity>,
}
pub struct EditBatch {
    pub changes: Vec<Change>,
    pub entities: Vec<EntityChange>,
}
impl From<Vec<Change>> for EditBatch {
    fn from(changes: Vec<Change>) -> Self {
        Self {
            changes,
            entities: Vec::new(),
        }
    }
}

/// A deliberate type transition matches the shared engine. Re-selecting a
/// dynamic body preserves explicitly disabled gravity; carrying never calls this.
pub fn set_body_type(body: &mut pb::BodyConfig, body_type: i32) -> bool {
    if body.r#type == body_type {
        return false;
    }
    if body_type == 0 {
        body.use_gravity = Some(true);
    }
    body.r#type = body_type;
    true
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
    pub selection_shape: crate::selection::SelectionShape,
    pub connected_selection: Option<Vec<Cell>>,
    pub component_selection: Option<crate::selection::ComponentSelection>,
    pub gradient: Option<pb::PaletteEntry>,
    pub clipboard: Option<pb::InventoryResource>,
    pub undo: Vec<EditBatch>,
    pub redo: Vec<EditBatch>,
    pub backpack: crate::backpack::Backpack,
    pub entities: Vec<PlacedEntity>,
    pub selected_entity: Option<usize>,
    pub revision: u64,
    stroke: Option<EditBatch>,
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
            selection_shape: Default::default(),
            connected_selection: None,
            component_selection: None,
            gradient: None,
            clipboard: None,
            undo: Vec::new(),
            redo: Vec::new(),
            backpack: Default::default(),
            entities: Vec::new(),
            selected_entity: None,
            revision: 0,
            stroke: None,
        }
    }
}
impl Editor {
    fn restore_entity(&mut self, change: &EntityChange, forward: bool) {
        let (remove, restore) = if forward {
            (&change.before, &change.after)
        } else {
            (&change.after, &change.before)
        };
        if let Some(entity) = remove {
            self.entities.retain(|e| e.id != entity.id);
        }
        if let Some(entity) = restore {
            self.entities.retain(|e| e.id != entity.id);
            let index = change.index.min(self.entities.len());
            self.entities.insert(index, entity.clone());
            self.selected_entity = Some(index);
        } else {
            self.selected_entity = None;
        }
    }
    pub fn record_entities(&mut self, changes: Vec<EntityChange>) {
        if changes.is_empty() {
            return;
        }
        if let Some(stroke) = &mut self.stroke {
            for change in changes {
                let id = change
                    .before
                    .as_ref()
                    .or(change.after.as_ref())
                    .map(|e| e.id.as_str());
                if let Some(existing) = stroke.entities.iter_mut().find(|e| {
                    e.before
                        .as_ref()
                        .or(e.after.as_ref())
                        .map(|e| e.id.as_str())
                        == id
                }) {
                    existing.after = change.after;
                } else {
                    stroke.entities.push(change);
                }
            }
        } else {
            self.undo.push(EditBatch {
                changes: Vec::new(),
                entities: changes,
            });
            if self.undo.len() > 128 {
                self.undo.remove(0);
            }
        }
        self.redo.clear();
        self.revision += 1;
    }
    pub fn update_entity(
        &mut self,
        index: usize,
        change: impl FnOnce(&mut PlacedEntity) -> Result<()>,
    ) -> Result<()> {
        let before = self
            .entities
            .get(index)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Entity no longer exists"))?;
        let mut after = before.clone();
        change(&mut after)?;
        protocol::validate_entity(&after.definition)?;
        ensure!(
            after
                .position
                .iter()
                .chain(after.rotation.iter())
                .all(|n| n.is_finite())
                && (DQuat::from_array(after.rotation).length_squared() - 1.0).abs() < 1e-6,
            "Invalid entity transform"
        );
        if before == after {
            return Ok(());
        }
        self.entities[index] = after.clone();
        self.record_entities(vec![EntityChange {
            index,
            before: Some(before),
            after: Some(after),
        }]);
        Ok(())
    }
    pub fn delete_entity(&mut self, index: usize) -> Result<()> {
        ensure!(index < self.entities.len(), "Entity no longer exists");
        let before = self.entities.remove(index);
        self.selected_entity = None;
        self.record_entities(vec![EntityChange {
            index,
            before: Some(before),
            after: None,
        }]);
        Ok(())
    }
    pub fn duplicate_entity(&mut self, index: usize) -> Result<()> {
        let mut after = self
            .entities
            .get(index)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Entity no longer exists"))?;
        after.id = uuid::Uuid::new_v4().to_string();
        after.running = false;
        after.velocity = [0.0; 3];
        after.position[0] += 2.0;
        let index = self.entities.len();
        self.entities.push(after.clone());
        self.selected_entity = Some(index);
        self.record_entities(vec![EntityChange {
            index,
            before: None,
            after: Some(after),
        }]);
        Ok(())
    }
    pub fn detach_component(&mut self, index: usize, id: &str) -> Result<()> {
        let before = self
            .entities
            .get(index)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Entity no longer exists"))?;
        let (after, detached) = crate::entity_edit::detach(&before, id)?;
        self.entities[index] = after.clone();
        let new_index = self.entities.len();
        self.entities.push(detached.clone());
        self.selected_entity = Some(new_index);
        self.record_entities(vec![
            EntityChange {
                index,
                before: Some(before),
                after: Some(after),
            },
            EntityChange {
                index: new_index,
                before: None,
                after: Some(detached),
            },
        ]);
        Ok(())
    }
    pub fn attach_entity(&mut self, target: usize, source: usize, parent: &str) -> Result<()> {
        ensure!(
            target < self.entities.len() && source < self.entities.len(),
            "Entity no longer exists"
        );
        let target_before = self.entities[target].clone();
        let source_before = self.entities[source].clone();
        let after = crate::entity_edit::merge(&target_before, &source_before, parent)?;
        self.entities[target] = after.clone();
        self.entities.remove(source);
        self.selected_entity = Some(if source < target { target - 1 } else { target });
        self.record_entities(vec![
            EntityChange {
                index: target,
                before: Some(target_before),
                after: Some(after),
            },
            EntityChange {
                index: source,
                before: Some(source_before),
                after: None,
            },
        ]);
        Ok(())
    }
    pub fn disassemble(&mut self, world: &mut World, index: usize) -> Result<()> {
        let before = self
            .entities
            .get(index)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Entity no longer exists"))?;
        let changes = crate::entity_edit::world_voxels(&before, true)?;
        ensure!(
            changes
                .iter()
                .all(|(c, _)| world.chunks.contains_key(&c.chunk())),
            "Entity crosses unloaded terrain"
        );
        self.end_stroke();
        let revision = self.revision;
        self.edit_selection_cells(world, changes);
        let delta = EntityChange {
            index,
            before: Some(before),
            after: None,
        };
        self.entities.remove(index);
        self.selected_entity = None;
        if self.revision != revision {
            self.undo.last_mut().unwrap().entities.push(delta);
            self.revision += 1;
        } else {
            self.record_entities(vec![delta]);
        }
        Ok(())
    }
    pub fn ensure_stroke(&mut self) {
        if self.stroke.is_none() {
            self.begin_stroke();
        }
    }
    pub fn begin_stroke(&mut self) {
        self.end_stroke();
        self.stroke = Some(EditBatch {
            changes: Vec::new(),
            entities: Vec::new(),
        });
    }
    pub fn end_stroke(&mut self) {
        if let Some(batch) = self
            .stroke
            .take()
            .filter(|b| !b.changes.is_empty() || !b.entities.is_empty())
        {
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
                stroke.changes.extend(batch);
            } else {
                self.undo.push(batch.into());
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
            for change in batch.entities.iter().rev() {
                self.restore_entity(change, false);
            }
            for c in batch.changes.iter().rev() {
                world.set(c.cell, c.before);
            }
            self.redo.push(batch);
            self.revision += 1;
        }
    }
    pub fn redo(&mut self, world: &mut World) {
        self.end_stroke();
        if let Some(batch) = self.redo.pop() {
            for c in &batch.changes {
                world.set(c.cell, c.after);
            }
            for change in &batch.entities {
                self.restore_entity(change, true);
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
    pub fn selection_bounds(&self) -> Result<(DVec3, DVec3)> {
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
        Ok((pa.min(pb), pa.max(pb) + DVec3::splat(a.scale())))
    }
    pub fn selection_cells(&self, world: &World) -> Result<Vec<Cell>> {
        if let Some(cells) = &self.connected_selection {
            ensure!(
                cells.len() <= 65536 && cells.iter().all(|c| world.chunks.contains_key(&c.chunk())),
                "Selection exceeds loaded terrain or 65,536 cells"
            );
            return Ok(cells.clone());
        }
        let (min, max) = self.selection_bounds()?;
        Self::require_loaded(world, min, max)?;
        let (a, b) = self.selection.unwrap();
        let scale = if a.micro { 8.0 } else { 1.0 };
        let pa = a.position();
        let mut pb = b.position();
        pb.x = crate::geometry::wrap_near(pb.x, pa.x, 16384.0);
        pb.z = crate::geometry::wrap_near(pb.z, pa.z, 2048.0);
        Ok(self
            .selection_shape
            .cells(
                (pa * scale).round().as_ivec3(),
                (pb * scale).round().as_ivec3(),
                262144,
            )?
            .into_iter()
            .map(|p| Cell::new(p.x, p.y, p.z, a.micro))
            .collect())
    }
    pub fn selection_values(&self, world: &World) -> Result<Vec<(Cell, u32)>> {
        let mut result = Vec::new();
        let mut empty_parents = std::collections::HashSet::new();
        let mut chunks = std::collections::HashSet::new();
        for c in self.selection_cells(world)? {
            if c.micro {
                let parent = Cell::new(
                    c.x.div_euclid(8),
                    c.y.div_euclid(8),
                    c.z.div_euclid(8),
                    false,
                );
                let parent_value = world.get(parent);
                let value = if parent_value != 0 {
                    parent_value
                } else {
                    world.get(c)
                };
                if value != 0 {
                    result.push((c, value));
                }
            } else {
                let value = world.get(c);
                if value != 0 {
                    result.push((c, value));
                } else {
                    empty_parents.insert(c);
                    chunks.insert(c.chunk());
                }
            }
            ensure!(result.len() <= 65536, "Selection exceeds 65,536 voxels");
        }
        // Visit actual micro data once per chunk instead of making 512 lookups for every empty standard cell.
        for key in chunks {
            if let Some(chunk) = world.chunks.get(&key) {
                for (&[x, y, z], &value) in &chunk.micro {
                    let c = Cell::new(key.0 * 128 + x, y, key.1 * 128 + z, true);
                    let parent = Cell::new(
                        c.x.div_euclid(8),
                        c.y.div_euclid(8),
                        c.z.div_euclid(8),
                        false,
                    );
                    if value != 0 && empty_parents.contains(&parent) {
                        result.push((c, value));
                        ensure!(result.len() <= 65536, "Selection exceeds 65,536 voxels");
                    }
                }
            }
        }
        result.sort_unstable_by_key(|(c, _)| *c);
        Ok(result)
    }
    pub fn copy_selection(&mut self, world: &World) -> Result<()> {
        let (min, _) = self.selection_bounds()?;
        let origin = min.floor();
        let values = self.selection_values(world)?;
        ensure!(!values.is_empty(), "Selection contains no voxels");
        let voxels = values
            .into_iter()
            .map(|(cell, value)| {
                let mut p = cell.position();
                p.x = crate::geometry::wrap_near(p.x, min.x, 16384.0);
                p.z = crate::geometry::wrap_near(p.z, min.z, 2048.0);
                voxel_at(p, cell.micro, value, origin)
            })
            .collect();
        self.clipboard = Some(pb::InventoryResource {
            schema_version: 8,
            content: Some(pb::inventory_resource::Content::BlockSet(pb::BlockSet {
                name: "Selection".into(),
                blocks: voxels,
            })),
        });
        Ok(())
    }
    pub fn edit_selection_cells(&mut self, world: &mut World, changes: Vec<(Cell, u32)>) {
        let parents: std::collections::BTreeSet<_> = changes
            .iter()
            .filter(|(c, _)| c.micro)
            .map(|(c, _)| {
                Cell::new(
                    c.x.div_euclid(8),
                    c.y.div_euclid(8),
                    c.z.div_euclid(8),
                    false,
                )
            })
            .filter(|c| world.get(*c) != 0)
            .collect();
        let mut expanded = Vec::new();
        for p in parents {
            let value = world.get(p);
            expanded.push((p, 0));
            for z in 0..8 {
                for y in 0..8 {
                    for x in 0..8 {
                        expanded.push((
                            Cell::new(p.x * 8 + x, p.y * 8 + y, p.z * 8 + z, true),
                            value,
                        ));
                    }
                }
            }
        }
        expanded.extend(changes);
        self.edit(world, expanded);
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
        let cells = if matches!(action, SelectionAction::Fill) {
            self.selection_cells(world)?
        } else {
            self.selection_values(world)?
                .into_iter()
                .map(|(c, _)| c)
                .collect()
        };
        ensure!(cells.len() <= 65536, "Selection edit exceeds 65,536 cells");
        let (min, max) = self.selection_bounds()?;
        let extent = max - min;
        let axis = if extent.y >= extent.x && extent.y >= extent.z {
            1
        } else if extent.x >= extent.z {
            0
        } else {
            2
        };
        let changes = cells
            .into_iter()
            .map(|c| {
                let mut p = c.position();
                p.x = crate::geometry::wrap_near(p.x, min.x, 16384.0);
                p.z = crate::geometry::wrap_near(p.z, min.z, 2048.0);
                let rgb = self.gradient.as_ref().map_or(self.rgb, |g| {
                    crate::palette::sample(
                        g,
                        if extent[axis] > c.scale() {
                            (p[axis] - min[axis]) / (extent[axis] - c.scale())
                        } else {
                            0.0
                        },
                    )
                });
                (
                    c,
                    if matches!(action, SelectionAction::Erase) {
                        0
                    } else {
                        color(rgb, self.material)
                    },
                )
            })
            .collect();
        self.edit_selection_cells(world, changes);
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
        self.end_stroke();
        let first_entity = self.entities.len();
        let before_revision = self.revision;
        let p = position;
        use pb::inventory_resource::Content;
        match r.content.as_ref().unwrap() {
            Content::BlockSet(b) => self.place_blocks(world, &b.blocks, p)?,
            Content::Entity(e) => {
                let mut definition = e.clone();
                let root = definition.root.as_mut().unwrap();
                let offset = crate::entity_edit::vector(root.local_position.take().as_ref());
                let rotation = crate::entity_edit::quaternion(root.local_rotation.take().as_ref());
                let mut placed = PlacedEntity::new(definition, p + offset);
                placed.rotation = rotation.to_array();
                self.entities.push(placed);
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
        let changes: Vec<_> = self
            .entities
            .iter()
            .enumerate()
            .skip(first_entity)
            .map(|(index, after)| EntityChange {
                index,
                before: None,
                after: Some(after.clone()),
            })
            .collect();
        if !changes.is_empty() {
            if self.revision != before_revision {
                self.undo.last_mut().unwrap().entities.extend(changes);
            } else {
                self.record_entities(changes);
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
                use_gravity: Some(false),
                collision_enabled: Some(true),
                restitution: Some(0.1),
                friction: Some(0.7),
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
    /// Move the selected terrain into one stopped, editable entity. Terrain and
    /// entity creation share an undo entry; clipboard/inventory are unaffected.
    pub fn assemble_selection(&mut self, world: &mut World) -> Result<usize> {
        self.end_stroke();
        let (a, b) = self
            .selection
            .ok_or_else(|| anyhow::anyhow!("Select two corners first"))?;
        let pa = a.position();
        let mut pb = b.position();
        pb.x = crate::geometry::wrap_near(pb.x, pa.x, 16384.0);
        pb.z = crate::geometry::wrap_near(pb.z, pa.z, 2048.0);
        let origin = pa.min(pb).floor();
        let saved = self.clipboard.take();
        let result = self.entityize(world);
        let resource = self.clipboard.take();
        self.clipboard = saved;
        result?;
        let Some(pb::inventory_resource::Content::Entity(definition)) =
            resource.and_then(|r| r.content)
        else {
            unreachable!()
        };
        protocol::validate_entity(&definition)?;
        let blocks = &definition.root.as_ref().unwrap().blocks;
        let count = blocks.len();
        let changes: Vec<_> = blocks
            .iter()
            .map(|v| {
                let scale = if v.is_micro { 8 } else { 1 };
                (
                    Cell::new(
                        origin.x as i32 * scale
                            + v.dx * scale
                            + if v.is_micro { v.micro_x as i32 } else { 0 },
                        origin.y as i32 * scale
                            + v.dy * scale
                            + if v.is_micro { v.micro_y as i32 } else { 0 },
                        origin.z as i32 * scale
                            + v.dz * scale
                            + if v.is_micro { v.micro_z as i32 } else { 0 },
                        v.is_micro,
                    ),
                    0,
                )
            })
            .collect();
        let entity = PlacedEntity::new(definition, origin);
        self.edit_selection_cells(world, changes);
        self.undo
            .last_mut()
            .expect("Occupied assembly creates terrain history")
            .entities
            .push(EntityChange {
                index: self.entities.len(),
                before: None,
                after: Some(entity.clone()),
            });
        self.entities.push(entity);
        self.selected_entity = Some(self.entities.len() - 1);
        self.selection = None;
        Ok(count)
    }
}
pub fn voxel_at(position: DVec3, micro_cell: bool, value: u32, origin: DVec3) -> pb::Voxel {
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

impl Editor {
    /// Install a backpack resource under a stopped component in one undoable transaction.
    pub fn place_in_component(
        &mut self,
        target: usize,
        parent: &str,
        resource: &pb::InventoryResource,
        position: DVec3,
    ) -> Result<()> {
        use crate::entity_edit as tree;
        use pb::inventory_resource::Content;
        protocol::validate(resource)?;
        let mut staged = self
            .entities
            .get(target)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Target no longer exists"))?;
        ensure!(!staged.running, "Stop the target before attaching");
        let mut definitions = Vec::new();
        let (blocks, entities) = match resource.content.as_ref().unwrap() {
            Content::BlockSet(b) => (Some(b), Vec::new()),
            Content::Entity(e) => (None, vec![(e.clone(), false)]),
            Content::Item(i) => (
                i.block_set.as_ref(),
                i.entity_list.iter().cloned().map(|e| (e, true)).collect(),
            ),
            Content::ColorSet(_) => anyhow::bail!("Choose an Item to attach"),
        };
        if let Some(b) = blocks
            && !b.blocks.is_empty()
        {
            definitions.push(PlacedEntity::new(
                pb::Entity {
                    root: Some(pb::Component {
                        id: "blocks".into(),
                        name: b.name.clone(),
                        blocks: b.blocks.clone(),
                        body: Some(tree::stopped_body()),
                        ..Default::default()
                    }),
                    constraints: Vec::new(),
                },
                position,
            ));
        }
        for (mut definition, relative_anchors) in entities {
            let root = definition.root.as_mut().unwrap();
            let offset = tree::vector(root.local_position.take().as_ref());
            let rotation = tree::quaternion(root.local_rotation.take().as_ref());
            if relative_anchors {
                for j in &mut definition.constraints {
                    if j.body_a_component_id.is_none()
                        && let Some(anchor) = &mut j.anchor_a
                    {
                        *anchor = tree::pb_vector(tree::vector(Some(anchor)) + position);
                    }
                }
            }
            let mut entity = PlacedEntity::new(definition, position + offset);
            entity.rotation = rotation.to_array();
            definitions.push(entity);
        }
        ensure!(!definitions.is_empty(), "Item contains no geometry");
        for entity in definitions {
            staged = tree::merge(&staged, &entity, parent)?;
        }
        self.update_entity(target, |e| {
            *e = staged;
            Ok(())
        })
    }
}
