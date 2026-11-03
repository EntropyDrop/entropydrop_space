//! Every UI button and key binding dispatches the same native editor command.
use crate::{
    editor::{Editor, EntityChange, PlacedEntity, SelectionAction},
    entity_edit,
    protocol::inventory as pb,
    selection,
    world::{Cell, World},
};
use anyhow::{Context, Result, ensure};
use glam::DQuat;

#[derive(Clone, Copy, Debug)]
pub enum Command {
    Copy,
    Cut,
    Erase,
    Fill,
    Paint,
    Assemble,
    SelectAll,
    Clear,
    Undo,
    Redo,
    Start,
    Stop,
    Duplicate,
    CopyEntity,
    CutEntity,
    DeleteEntity,
    ResetRotation,
    Disassemble,
    Detach,
    BodyType(i32),
}

impl Editor {
    pub fn command(&mut self, world: &mut World, command: Command) -> Result<String> {
        match command {
            Command::Undo => {
                self.undo(world);
                return Ok("Undo".into());
            }
            Command::Redo => {
                self.redo(world);
                return Ok("Redo".into());
            }
            Command::Clear => {
                self.selection = None;
                self.connected_selection = None;
                self.component_selection = None;
                return Ok("Selection cleared".into());
            }
            Command::Copy
            | Command::Cut
            | Command::Erase
            | Command::Fill
            | Command::Paint
            | Command::Assemble
                if self.component_selection.is_some() =>
            {
                return self.component_command(command);
            }
            Command::Copy | Command::Cut => {
                return self.copy_world_item(world, matches!(command, Command::Cut));
            }
            Command::Erase | Command::Fill | Command::Paint => {
                self.change_selection(
                    world,
                    match command {
                        Command::Erase => SelectionAction::Erase,
                        Command::Fill => SelectionAction::Fill,
                        _ => SelectionAction::Paint,
                    },
                )?;
                return Ok("Selection updated".into());
            }
            Command::Assemble => {
                let count = self.assemble_selection(world)?;
                return Ok(format!(
                    "{count} blocks assembled · C edits the aimed entity"
                ));
            }
            _ => {}
        }
        let index = self
            .selected_entity
            .filter(|i| *i < self.entities.len())
            .context("Select an entity first")?;
        match command {
            Command::SelectAll => {
                let e = &self.entities[index];
                let root = e.definition.root.as_ref().context("Entity has no root")?;
                self.selection = None;
                self.connected_selection = None;
                self.component_selection = Some(selection::ComponentSelection {
                    entity: e.id.clone(),
                    component: root.id.clone(),
                    a: glam::IVec3::ZERO,
                    b: glam::IVec3::ZERO,
                    micro: false,
                    all: true,
                    extra: Vec::new(),
                });
            }
            Command::Start | Command::Stop => self.update_entity(index, |e| {
                e.running = matches!(command, Command::Start);
                Ok(())
            })?,
            Command::BodyType(kind) => self.update_entity(index, |e| {
                let root = e.definition.root.as_mut().context("Entity has no root")?;
                let body = root.body.get_or_insert_default();
                crate::editor::set_body_type(body, kind);
                Ok(())
            })?,
            Command::Duplicate => self.duplicate_entity(index)?,
            Command::CopyEntity | Command::CutEntity => {
                ensure!(
                    !self.entities[index].running,
                    "Stop the entity before copying or cutting"
                );
                let resource = pb::InventoryResource {
                    schema_version: 8,
                    content: Some(pb::inventory_resource::Content::Entity(
                        self.entities[index].definition.clone(),
                    )),
                };
                self.backpack.insert(resource.clone())?;
                self.clipboard = Some(resource);
                if matches!(command, Command::CutEntity) {
                    self.delete_entity(index)?;
                }
                self.revision += 1;
            }
            Command::DeleteEntity => self.delete_entity(index)?,
            Command::ResetRotation => self.update_entity(index, |e| {
                e.running = false;
                e.rotation = DQuat::IDENTITY.to_array();
                Ok(())
            })?,
            Command::Disassemble => self.disassemble(world, index)?,
            Command::Detach => {
                let id = self
                    .component_selection
                    .as_ref()
                    .context("Select a component first")?
                    .component
                    .clone();
                self.detach_component(index, &id)?;
            }
            _ => {}
        }
        Ok(format!("{command:?} completed"))
    }
    fn component_command(&mut self, command: Command) -> Result<String> {
        let selection = self
            .component_selection
            .clone()
            .context("Select component blocks first")?;
        let index = self
            .entities
            .iter()
            .position(|e| e.id == selection.entity)
            .context("Entity no longer exists")?;
        ensure!(
            !self.entities[index].running,
            "Stop the entity before editing blocks"
        );
        let root = self.entities[index]
            .definition
            .root
            .as_ref()
            .context("Entity has no root")?;
        let node =
            entity_edit::find(root, &selection.component).context("Component no longer exists")?;
        let (mut selected, mut remaining) =
            selection::partition_voxels(&node.blocks, &selection, self.selection_shape)?;
        if matches!(command, Command::Copy | Command::Cut) {
            ensure!(!selected.is_empty(), "Selection contains no voxels");
            let resource = pb::InventoryResource {
                schema_version: 8,
                content: Some(pb::inventory_resource::Content::BlockSet(pb::BlockSet {
                    name: node.name.clone(),
                    blocks: selected.clone(),
                })),
            };
            self.backpack.insert(resource.clone())?;
            self.clipboard = Some(resource);
            self.revision += 1;
            if matches!(command, Command::Copy) {
                return Ok("Component blocks copied to backpack".into());
            }
        }
        let rgb = self.rgb;
        let material = self.material;
        let gradient = self.gradient.clone();
        let child_id = entity_edit::unique_id(root, "component");
        if matches!(command, Command::Fill) {
            ensure!(!selection.all, "Define a bounded range to fill");
            selected = self
                .selection_shape
                .cells(selection.a, selection.b, 65536)?
                .into_iter()
                .map(|p| {
                    let base = if selection.micro {
                        p.div_euclid(glam::IVec3::splat(8))
                    } else {
                        p
                    };
                    pb::Voxel {
                        dx: base.x,
                        dy: base.y,
                        dz: base.z,
                        is_micro: selection.micro,
                        micro_x: if selection.micro {
                            p.x.rem_euclid(8) as u32
                        } else {
                            0
                        },
                        micro_y: if selection.micro {
                            p.y.rem_euclid(8) as u32
                        } else {
                            0
                        },
                        micro_z: if selection.micro {
                            p.z.rem_euclid(8) as u32
                        } else {
                            0
                        },
                        color_rgb: rgb,
                        material_id: material,
                    }
                })
                .collect();
        }
        if matches!(command, Command::Paint | Command::Fill) {
            let min = selected
                .iter()
                .map(|v| v.dy as f64 + v.micro_y as f64 / 8.0)
                .fold(f64::INFINITY, f64::min);
            let max = selected
                .iter()
                .map(|v| v.dy as f64 + v.micro_y as f64 / 8.0)
                .fold(f64::NEG_INFINITY, f64::max);
            for v in &mut selected {
                v.color_rgb = gradient.as_ref().map_or(rgb, |g| {
                    crate::palette::sample(
                        g,
                        if max > min {
                            (v.dy as f64 + v.micro_y as f64 / 8.0 - min) / (max - min)
                        } else {
                            0.0
                        },
                    )
                });
                v.material_id = material;
            }
            remaining.extend(selected.clone());
        }
        self.update_entity(index, |e| {
            let node =
                entity_edit::find_mut(e.definition.root.as_mut().unwrap(), &selection.component)
                    .context("Component no longer exists")?;
            node.blocks = remaining;
            if matches!(command, Command::Assemble) {
                ensure!(!selected.is_empty(), "Selection contains no voxels");
                node.children.push(pb::Component {
                    id: child_id,
                    name: "Component".into(),
                    body: Some(entity_edit::stopped_body()),
                    blocks: selected,
                    script_language: "assemblyscript".into(),
                    ..Default::default()
                });
            }
            Ok(())
        })?;
        self.component_selection = None;
        Ok("Component selection updated".into())
    }
    pub fn select_connected(&mut self, world: &World, start: Cell) -> Result<usize> {
        use std::collections::{HashSet, VecDeque};
        let mut visited = HashSet::new();
        let mut queue = VecDeque::from([start]);
        let mut cells = Vec::new();
        let value = |c: Cell| {
            if c.micro {
                let p = Cell::new(
                    c.x.div_euclid(8),
                    c.y.div_euclid(8),
                    c.z.div_euclid(8),
                    false,
                );
                if world.get(p) != 0 {
                    world.get(p)
                } else {
                    world.get(c)
                }
            } else {
                world.get(c)
            }
        };
        while let Some(c) = queue.pop_front() {
            if !visited.insert(c) || value(c) == 0 {
                continue;
            }
            ensure!(
                world.chunks.contains_key(&c.chunk()),
                "Connected selection reaches unloaded terrain"
            );
            cells.push(c);
            ensure!(
                cells.len() <= 65536,
                "Connected selection exceeds 65,536 voxels"
            );
            for d in [
                glam::IVec3::X,
                -glam::IVec3::X,
                glam::IVec3::Y,
                -glam::IVec3::Y,
                glam::IVec3::Z,
                -glam::IVec3::Z,
            ] {
                let next = Cell::new(c.x + d.x, c.y + d.y, c.z + d.z, c.micro);
                if (0..if c.micro { 2048 } else { 256 }).contains(&next.y) {
                    queue.push_back(next);
                }
            }
        }
        ensure!(!cells.is_empty(), "No connected blocks");
        let seed = start.position();
        let mut min = seed;
        let mut max = seed;
        for c in &cells {
            let mut p = c.position();
            p.x = crate::geometry::wrap_near(p.x, seed.x, 16384.0);
            p.z = crate::geometry::wrap_near(p.z, seed.z, 2048.0);
            min = min.min(p);
            max = max.max(p);
        }
        let scale = if start.micro { 8.0 } else { 1.0 };
        let a = (min * scale).round().as_ivec3();
        let b = (max * scale).round().as_ivec3();
        self.selection = Some((
            Cell::new(a.x, a.y, a.z, start.micro),
            Cell::new(b.x, b.y, b.z, start.micro),
        ));
        let count = cells.len();
        self.connected_selection = Some(cells);
        self.component_selection = None;
        Ok(count)
    }
    pub fn record_transform(&mut self, before: PlacedEntity) {
        if let Some((index, after)) = self
            .entities
            .iter()
            .enumerate()
            .find(|(_, e)| e.id == before.id)
            .map(|(i, e)| (i, e.clone()))
            && before != after
        {
            self.record_entities(vec![EntityChange {
                index,
                before: Some(before),
                after: Some(after),
            }]);
        }
    }
}

impl Editor {
    fn copy_world_item(&mut self, world: &mut World, cut: bool) -> Result<String> {
        use glam::{DMat4, DVec3};
        let (origin, max) = self.selection_bounds()?;
        let center = (origin + max) * 0.5;
        let values = self.selection_values(world)?;
        let blocks = values
            .iter()
            .map(|(cell, value)| {
                let mut p = cell.position();
                p.x = crate::geometry::wrap_near(p.x, origin.x, 16384.0);
                p.z = crate::geometry::wrap_near(p.z, origin.z, 2048.0);
                crate::editor::voxel_at(p, cell.micro, *value, origin)
            })
            .collect::<Vec<_>>();
        let mut entities = Vec::new();
        let mut sources = Vec::new();
        fn enclosed(
            c: &pb::Component,
            root: &pb::Component,
            parent: DMat4,
            min: DVec3,
            max: DVec3,
        ) -> bool {
            let matrix = parent * entity_edit::matrix(root, &c.id).unwrap();
            for v in &c.blocks {
                let p = crate::interaction::voxel(v);
                let base = DVec3::new(p[0], p[1], p[2]);
                for bits in 0..8 {
                    let corner = matrix.transform_point3(
                        base + DVec3::new(
                            (bits & 1) as f64,
                            ((bits >> 1) & 1) as f64,
                            ((bits >> 2) & 1) as f64,
                        ) * p[3],
                    );
                    if (corner - min).min_element() < -1e-6 || (max - corner).min_element() < -1e-6
                    {
                        return false;
                    }
                }
            }
            c.children
                .iter()
                .all(|c| enclosed(c, root, parent, min, max))
        }
        for (index, e) in self.entities.iter().enumerate() {
            let Some(root) = &e.definition.root else {
                continue;
            };
            let p = DVec3::from_array(e.position);
            let offset = DVec3::new(
                crate::geometry::wrap_near(p.x, center.x, 16384.0) - p.x,
                0.0,
                crate::geometry::wrap_near(p.z, center.z, 2048.0) - p.z,
            );
            if !enclosed(
                root,
                root,
                DMat4::from_translation(offset) * entity_edit::pose(e),
                origin,
                max,
            ) {
                continue;
            }
            ensure!(
                !cut || !e.running,
                "Stop all enclosed entities before cutting"
            );
            let mut definition = e.definition.clone();
            let root = definition.root.as_mut().unwrap();
            root.local_position = Some(entity_edit::pb_vector(p + offset - origin));
            root.local_rotation = Some(entity_edit::pb_quaternion(DQuat::from_array(e.rotation)));
            for c in &mut definition.constraints {
                if c.body_a_component_id.is_none()
                    && let Some(anchor) = &mut c.anchor_a
                {
                    *anchor =
                        entity_edit::pb_vector(entity_edit::vector(Some(anchor)) + offset - origin);
                }
            }
            entities.push(definition);
            sources.push(index);
        }
        ensure!(
            !blocks.is_empty() || !entities.is_empty(),
            "Selection contains no world voxels or fully enclosed entities"
        );
        let message = format!(
            "{} voxels and {} entities copied to backpack",
            blocks.len(),
            entities.len()
        );
        let resource = pb::InventoryResource {
            schema_version: 8,
            content: Some(pb::inventory_resource::Content::Item(pb::Item {
                id: uuid::Uuid::new_v4().to_string(),
                name: "World selection".into(),
                block_set: (!blocks.is_empty()).then_some(pb::BlockSet {
                    name: "World selection".into(),
                    blocks,
                }),
                entity_list: entities,
            })),
        };
        self.backpack.insert(resource.clone())?;
        self.clipboard = Some(resource);
        if cut {
            self.begin_stroke();
            self.edit_selection_cells(world, values.into_iter().map(|(c, _)| (c, 0)).collect());
            for index in sources.into_iter().rev() {
                self.delete_entity(index)?;
            }
            self.end_stroke();
        }
        self.revision += 1;
        self.selection = None;
        self.connected_selection = None;
        Ok(message)
    }
}
