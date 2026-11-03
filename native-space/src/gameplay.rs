use super::*;
use glam::{DQuat, Quat, Vec3};
use space_native::{protocol::inventory as pb, world::Hit};

pub(super) struct Grab {
    id: String,
    snapshot: space_native::editor::PlacedEntity,
    offset: DVec3,
    pub distance: f64,
}
pub(super) struct ModelDrag {
    snapshot: space_native::editor::PlacedEntity,
    component: String,
    decoration: String,
    local_to_world: glam::DMat4,
    origin: DVec3,
    plane_point: DVec3,
    plane_normal: DVec3,
    create: bool,
}
impl Game {
    #[cfg(test)]
    pub(super) fn assemble_selection(&mut self) -> Result<()> {
        let count = self.editor.assemble_selection(&mut self.world)?;
        self.selecting = false;
        self.status = format!("{count} blocks assembled · aim at the entity and press C to edit");
        Ok(())
    }
    pub(super) fn open_entity_editor(&mut self, picked: Option<(String, f64)>) {
        let Some(index) =
            picked.and_then(|(id, _)| self.editor.entities.iter().position(|e| e.id == id))
        else {
            self.status = "Aim at an entity and press C to edit".into();
            return;
        };
        self.end_tool(false);
        self.editor.selected_entity = Some(index);
        self.panel = Panel::Entities;
        self.panel_open = true;
        self.open_modal(space_native::ui_state::Modal::Editor);
    }
    pub(super) fn view(&self) -> (DVec3, DVec3) {
        let direction = self.camera.direction();
        if self.perspective == 0 {
            return (self.camera.position, direction);
        }
        let target = self.camera.position - DVec3::Y * 0.35;
        let offset = if self.perspective == 1 {
            -direction
        } else {
            direction
        };
        let desired = self.interface.preferences.camera_distance;
        let distance = self
            .world
            .raycast(target, offset, desired)
            .map_or(desired, |h| (h.distance - 0.3).max(0.3));
        let eye = target + offset * distance;
        (eye, (target - eye).normalize())
    }
    pub(super) fn hit(&self) -> Option<Hit> {
        let (eye, direction) = self.view();
        self.world.raycast(eye, direction, 50.0)
    }
    pub(super) fn placement(&self) -> DVec3 {
        if let Some(pinned) = &self.interface.placement {
            return pinned.position;
        }
        let (eye, direction) = self.view();
        let point = self
            .hit()
            .map_or(eye + direction * 8.0, |h| h.point + h.normal * 0.002);
        let full_blocks = match self
            .editor
            .clipboard
            .as_ref()
            .and_then(|r| r.content.as_ref())
        {
            Some(pb::inventory_resource::Content::BlockSet(b)) => {
                b.blocks.iter().any(|v| !v.is_micro)
            }
            Some(pb::inventory_resource::Content::Item(i)) => i
                .block_set
                .as_ref()
                .is_some_and(|b| b.blocks.iter().any(|v| !v.is_micro)),
            _ => false,
        };
        interaction::snap(point, self.editor.micro && !full_blocks)
    }
    pub(super) fn choose_tool(&mut self, tool: HotbarTool) {
        self.end_tool(true);
        self.active_tool = tool;
        self.selecting = false;
        self.preview_dirty = true;
        self.interface.placement = None;
        self.interface.brush_corner = None;
        if let Some(index) = match tool {
            HotbarTool::Select => Some(0),
            HotbarTool::Hammer => Some(1),
            HotbarTool::Brush => Some(2),
            _ => None,
        } {
            self.editor.micro = self.interface.preferences.tool_micro[index];
        }
        self.editor.tool = match tool {
            HotbarTool::Select => Tool::Select,
            HotbarTool::Brush => Tool::Paint,
            _ => Tool::Build,
        };
        if matches!(tool, HotbarTool::Shovel | HotbarTool::Spoon) {
            self.editor.micro = tool == HotbarTool::Spoon;
        }
    }
    pub(super) fn end_tool(&mut self, cancel: bool) {
        if let Some(drag) = self.model_drag.take() {
            if cancel {
                if let Some(e) = self
                    .editor
                    .entities
                    .iter_mut()
                    .find(|e| e.id == drag.snapshot.id)
                {
                    *e = drag.snapshot;
                    self.editor.revision += 1;
                }
            } else {
                self.editor.record_transform(drag.snapshot);
            }
        }
        self.editor.end_stroke();
        self.held_tool = None;
        if let Some(before) = self.gizmo_before.take() {
            if cancel {
                if let Some(e) = self.editor.entities.iter_mut().find(|e| e.id == before.id) {
                    *e = before;
                    self.editor.revision += 1;
                }
            } else {
                self.editor.record_transform(before);
            }
        }
        if cancel {
            self.last_grab_click = None;
        }
        if let Some(grab) = self.grab.take() {
            if cancel {
                if let Some(e) = self.editor.entities.iter_mut().find(|e| e.id == grab.id) {
                    *e = grab.snapshot;
                    self.editor.revision += 1;
                    self.status = "Move cancelled".into();
                }
            } else {
                self.editor.record_transform(grab.snapshot);
            }
        }
    }
    pub(super) fn confirm_placement(&mut self) -> Result<()> {
        let pinned = self
            .interface
            .placement
            .clone()
            .context("Click to pin a placement preview first")?;
        if let Some((entity, parent)) = &pinned.parent {
            let target = self
                .editor
                .entities
                .iter()
                .position(|e| &e.id == entity)
                .context("Target no longer exists")?;
            let resource = self.editor.clipboard.clone().context("No Item selected")?;
            self.editor
                .place_in_component(target, parent, &resource, pinned.position)?;
            self.audio.effect(
                super::audio::Effect::Glue,
                self.interface.preferences.effects,
            );
        } else {
            self.editor.paste(&mut self.world, pinned.position)?;
        }
        self.interface.placement = None;
        self.audio.effect(
            super::audio::Effect::Place,
            self.interface.preferences.effects,
        );
        self.status = "Placed locally · Cmd/Ctrl+Z to undo".into();
        Ok(())
    }

    fn stamp(&mut self, secondary: bool) {
        let Some(mut hit) = self.hit() else {
            return;
        };
        let tool = match self.active_tool {
            HotbarTool::Shovel | HotbarTool::Spoon => {
                if secondary {
                    Tool::Build
                } else {
                    Tool::Erase
                }
            }
            HotbarTool::Brush => {
                if secondary {
                    Tool::Pick
                } else {
                    Tool::Paint
                }
            }
            _ => return,
        };
        if self.active_tool == HotbarTool::Spoon && tool == Tool::Erase && !hit.cell.micro {
            // Expose a standard voxel as micro cells before carving. This is
            // part of the same stroke, so undo restores the original full cell.
            let parent = hit.cell;
            let value = self.world.get(parent);
            let mut changes = vec![(parent, 0)];
            for z in 0..8 {
                for y in 0..8 {
                    for x in 0..8 {
                        changes.push((
                            space_native::world::Cell::new(
                                parent.x * 8 + x,
                                parent.y * 8 + y,
                                parent.z * 8 + z,
                                true,
                            ),
                            value,
                        ));
                    }
                }
            }
            self.editor.edit(&mut self.world, changes);
            if let Some(next) = self.hit() {
                hit = next;
            }
        }
        self.editor.micro = self.active_tool == HotbarTool::Spoon
            || (self.active_tool == HotbarTool::Brush && hit.cell.micro);
        self.editor.tool = tool;
        self.editor.apply_hit(&mut self.world, hit, false);
    }
    pub(super) fn tool_press(
        &mut self,
        secondary: bool,
        picked: Option<(String, f64)>,
    ) -> Result<()> {
        match self.active_tool {
            HotbarTool::Select => {
                if secondary {
                    self.selecting = false;
                    self.editor.selection = None;
                } else if let Some(hit) = self.hit() {
                    if !self.selecting {
                        self.editor.selection = None;
                    }
                    self.editor.tool = Tool::Select;
                    self.editor.apply_hit(&mut self.world, hit, false);
                    self.selecting = !self.selecting;
                }
            }
            HotbarTool::Hammer => {
                if secondary {
                    self.interface.placement = None;
                } else if self.interface.placement.is_none() {
                    anyhow::ensure!(
                        self.editor.clipboard.is_some(),
                        "Choose an item in the backpack first"
                    );
                    self.interface.placement = Some(space_native::ui_state::Placement {
                        position: self.placement(),
                        rotation: DQuat::IDENTITY,
                        parent: None,
                    });
                    self.status = "Preview pinned · Enter to build · RMB to cancel".into();
                }
            }
            HotbarTool::Wrench => {
                let (eye, dir) = self.view();
                if let Some((id, distance)) = picked {
                    let Some(index) = self.editor.entities.iter().position(|e| e.id == id) else {
                        return Ok(());
                    };
                    self.editor.selected_entity = Some(index);
                    if secondary {
                        self.interface.context_menu = Some(space_native::ui_state::ContextMenu {
                            position: [-1.0, -1.0],
                            entity: Some(id),
                            component: self.interface.component.clone(),
                            confirm_delete: false,
                        });
                        self.capture_request = Some(false);
                        return Ok(());
                    }
                    let double = self.last_grab_click.as_ref().is_some_and(|(last, time)| {
                        last == &id && time.elapsed().as_secs_f32() < 0.3
                    });
                    self.last_grab_click = Some((id.clone(), Instant::now()));
                    let e = &mut self.editor.entities[index];
                    if double {
                        let before = e.clone();
                        e.running = !e.running;
                        self.editor.record_transform(before);
                        self.last_grab_click = None;
                    } else if !e.running {
                        self.grab = Some(Grab {
                            id,
                            snapshot: e.clone(),
                            offset: DVec3::from_array(e.position) - (eye + dir * distance),
                            distance,
                        });
                    } else {
                        self.status = "Double-click to stop before moving this entity".into();
                    }
                }
            }
            HotbarTool::Model => {
                anyhow::bail!("Aim at a stopped entity: LMB selects, RMB creates a decoration")
            }
            _ => {
                self.editor.begin_stroke();
                self.held_tool = Some(secondary);
                self.stroke_elapsed = 0.0;
                self.stamp(secondary);
                if self.active_tool == HotbarTool::Brush && secondary {
                    self.end_tool(false);
                }
            }
        }
        Ok(())
    }
    pub(super) fn rotate_tool(&mut self, axis: usize, direction: i32) {
        if self.interface.placement.is_some() {
            return;
        }
        if self.active_tool == HotbarTool::Hammer {
            if let Some(resource) = &self.editor.clipboard {
                match space_native::resource_transform::rotate(resource, axis, direction) {
                    Ok(next) => {
                        self.editor.clipboard = Some(next);
                        self.preview_dirty = true;
                    }
                    Err(e) => self.status = e.to_string(),
                }
            }
        } else if self.active_tool == HotbarTool::Select && !self.selecting {
            if let Some(selection) = &mut self.editor.component_selection {
                let (a, b) =
                    self.editor
                        .selection_shape
                        .rotate(selection.a, selection.b, axis, direction);
                selection.a = a;
                selection.b = b;
            } else if let Some((a, b)) = self.editor.selection {
                let (first, last) = self.editor.selection_shape.rotate(
                    glam::IVec3::new(a.x, a.y, a.z),
                    glam::IVec3::new(b.x, b.y, b.z),
                    axis,
                    direction,
                );
                self.editor.selection = Some((
                    space_native::world::Cell::new(first.x, first.y, first.z, a.micro),
                    space_native::world::Cell::new(last.x, last.y, last.z, a.micro),
                ));
            }
        } else if let Some(grab) = &self.grab
            && let Some(e) = self.editor.entities.iter_mut().find(|e| e.id == grab.id)
        {
            e.rotation = (space_native::resource_transform::quarter(axis, direction)
                * DQuat::from_array(e.rotation))
            .to_array();
            self.editor.revision += 1;
        }
    }
    fn update_grab(&mut self) {
        if let Some(grab) = &self.grab {
            let (eye, dir) = self.view();
            let p = interaction::snap(eye + dir * grab.distance + grab.offset, self.editor.micro);
            if let Some(e) = self.editor.entities.iter_mut().find(|e| e.id == grab.id)
                && e.position != p.to_array()
            {
                e.position = p.to_array();
                self.editor.revision += 1;
            }
        }
    }
    pub(super) fn update_gameplay(
        &mut self,
        renderer: &mut Renderer,
        dt: f64,
        captured: bool,
    ) -> Result<()> {
        self.stroke_elapsed += dt;
        if captured
            && self.stroke_elapsed >= 0.1
            && let Some(secondary) = self.held_tool
        {
            self.stroke_elapsed = 0.0;
            if let Some(pick) = self.pick_scene(renderer) {
                let r = self.scene_press(secondary, Some(pick), false);
                self.result(r);
            } else {
                self.stamp(secondary);
            }
        }
        self.update_model_drag();
        self.update_grab();
        let preview = self.active_tool == HotbarTool::Hammer && self.editor.clipboard.is_some();
        if self.preview_dirty {
            renderer.retain_meshes(|k| !k.starts_with("preview:"));
            self.preview_parts.clear();
            if preview {
                let r = self.editor.clipboard.as_ref().unwrap();
                for (i, (mut faces, model)) in
                    interaction::resource_parts(r).into_iter().enumerate()
                {
                    for f in &mut faces {
                        f.color = (f.color & 0xffffff) | (76 << 24);
                    }
                    let key = format!("preview:{i}");
                    renderer.upload(key.clone(), &faces, Mat4::IDENTITY)?;
                    self.preview_parts.push((key, model));
                }
            }
            self.preview_dirty = false;
        }
        if !self.preview_parts.is_empty() {
            let placement = self.placement();
            for (key, local) in &self.preview_parts {
                renderer.set_model(key, Mat4::from_translation(placement.as_vec3()) * *local);
            }
        }
        if !preview && !self.preview_parts.is_empty() {
            renderer.retain_meshes(|k| !k.starts_with("preview:"));
            self.preview_parts.clear();
        }
        if self.avatar_mode != Some(self.perspective) {
            renderer.retain_meshes(|k| !k.starts_with("avatar:"));
            if self.perspective == 0 {
                renderer.upload(
                    "avatar:hand".into(),
                    &self.avatar.parts[2].faces,
                    Mat4::IDENTITY,
                )?;
            } else {
                for (i, p) in self.avatar.parts.iter().enumerate() {
                    renderer.upload(format!("avatar:{i}"), &p.faces, Mat4::IDENTITY)?;
                }
            }
            self.avatar_mode = Some(self.perspective);
        }
        let moving = self.camera.position.distance(self.previous_position) > 0.001;
        self.previous_position = self.camera.position;
        self.avatar_phase += dt.min(0.05) as f32 * 9.0;
        if self.perspective == 0 {
            let yaw = self.camera.yaw as f32;
            let pitch = self.camera.pitch as f32;
            let rotation = Quat::from_rotation_y(-yaw) * Quat::from_rotation_x(pitch);
            let camera = Mat4::from_rotation_translation(rotation, self.camera.position.as_vec3());
            renderer.set_model(
                "avatar:hand",
                camera
                    * Mat4::from_translation(Vec3::new(0.36, -0.26, -0.48))
                    * Mat4::from_rotation_x(0.6),
            );
        } else {
            let fixed = self
                .driver
                .as_ref()
                .and_then(|driver| {
                    self.runtime_frame
                        .as_ref()
                        .and_then(|f| f.entities.iter().find(|e| e.id == driver.id))
                        .and_then(|e| e.nodes.iter().find(|n| n.id == driver.component))
                        .and_then(|n| n.seats.iter().find(|s| s.index == driver.seat))
                })
                .filter(|s| s.fixed_orientation);
            let feet = (self.camera.position - DVec3::Y * 1.65).as_vec3();
            let correction = fixed.map_or(Mat4::IDENTITY, |s| {
                Mat4::from_translation(feet)
                    * Mat4::from_quat(Quat::from_array(s.rotation.map(|v| v as f32)))
                    * Mat4::from_translation(-feet)
            });
            for (i, model) in self
                .avatar
                .models(
                    (self.camera.position - DVec3::Y * 1.65).as_vec3(),
                    if fixed.is_some() {
                        std::f32::consts::PI
                    } else {
                        self.camera.yaw as f32
                    },
                    self.camera.pitch as f32,
                    self.avatar_phase,
                    moving,
                    self.driver.is_some(),
                )
                .into_iter()
                .enumerate()
            {
                renderer.set_model(&format!("avatar:{i}"), correction * model);
            }
        }
        Ok(())
    }
}

impl Game {
    pub(super) fn pick_scene(&self, renderer: &Renderer) -> Option<interaction::ScenePick> {
        let (eye, dir) = self.view();
        let hit = renderer.pick_mesh(eye, dir, self.hit().map_or(50.0, |h| h.distance + 0.01))?;
        fn find(
            c: &pb::Component,
            e: &str,
            hit: &interaction::MeshPick,
        ) -> Option<(String, Option<String>)> {
            let key = interaction::entity_mesh_key(e, &c.id);
            if hit.key == key || hit.key == format!("{key}:alpha") {
                return Some((c.id.clone(), None));
            }
            for d in &c.decorations {
                let key = interaction::decoration_mesh_key(e, &c.id, &d.id);
                if hit.key == key || hit.key == format!("{key}:alpha") {
                    return Some((c.id.clone(), Some(d.id.clone())));
                }
            }
            c.children.iter().find_map(|child| find(child, e, hit))
        }
        for e in &self.editor.entities {
            if let Some((component, decoration)) = e
                .definition
                .root
                .as_ref()
                .and_then(|root| find(root, &e.id, &hit))
            {
                return Some(interaction::ScenePick {
                    entity: e.id.clone(),
                    component,
                    decoration,
                    hit,
                });
            }
        }
        None
    }
    pub(super) fn click_running(&mut self, pick: Option<&interaction::ScenePick>) -> bool {
        use space_native::entity_edit as tree;
        let Some(pick) = pick else {
            return false;
        };
        let Some(entity) = self
            .editor
            .entities
            .iter()
            .find(|e| e.id == pick.entity && e.running)
        else {
            return false;
        };
        if matches!(self.active_tool, HotbarTool::Select | HotbarTool::Wrench) {
            if self
                .last_grab_click
                .as_ref()
                .is_some_and(|(id, t)| id == &pick.entity && t.elapsed().as_secs_f32() < 0.35)
            {
                self.last_grab_click = None;
                if let Some(index) = self
                    .editor
                    .entities
                    .iter()
                    .position(|e| e.id == pick.entity)
                {
                    self.editor.selected_entity = Some(index);
                    self.dispatch(space_native::commands::Command::Stop);
                }
                return true;
            }
            self.last_grab_click = Some((pick.entity.clone(), Instant::now()));
        }
        let Some(node) = self
            .runtime_frame
            .as_ref()
            .and_then(|f| f.entities.iter().find(|e| e.id == entity.id))
            .and_then(|e| e.nodes.iter().find(|n| n.id == pick.component))
        else {
            return true;
        };
        let world = pick
            .hit
            .model
            .transform_point3(pick.hit.local_point.as_vec3())
            .as_dvec3();
        let local = glam::Mat4::from_cols_array(&node.model)
            .inverse()
            .transform_point3(world.as_vec3())
            .as_dvec3();
        let inside = pick.hit.local_point - pick.hit.local_normal * 0.001;
        let definition = entity
            .definition
            .root
            .as_ref()
            .and_then(|r| tree::find(r, &pick.component));
        let block = node
            .voxels
            .as_ref()
            .and_then(|vs| {
                vs.iter()
                    .find(|v| {
                        inside.cmpge(DVec3::new(v[0], v[1], v[2])).all()
                            && inside
                                .cmplt(DVec3::new(v[0], v[1], v[2]) + DVec3::splat(v[3]))
                                .all()
                    })
                    .copied()
            })
            .or_else(|| {
                definition.and_then(|c| {
                    c.blocks.iter().map(interaction::voxel).find(|v| {
                        inside.cmpge(DVec3::new(v[0], v[1], v[2])).all()
                            && inside
                                .cmplt(DVec3::new(v[0], v[1], v[2]) + DVec3::splat(v[3]))
                                .all()
                    })
                })
            });
        let (position, size, kind) = if let Some(id) = &pick.decoration {
            let pos = node
                .decorations
                .iter()
                .find(|d| &d.id == id)
                .and_then(|d| d.position)
                .unwrap_or([0.0; 3]);
            (pos.map(f64::from), None, "decoration")
        } else if let Some(v) = block {
            (
                [v[0], v[1], v[2]],
                Some(v[3]),
                if v[3] < 1.0 { "micro" } else { "standard" },
            )
        } else {
            return true;
        };
        if self.pending_clicks.len() < 64 {
            self.pending_clicks.push(runtime::Click {
                event_id: uuid::Uuid::new_v4().to_string(),
                entity_id: entity.id.clone(),
                player_id: "local".into(),
                node_id: pick.component.clone(),
                kind: kind.into(),
                position,
                size,
                decoration_id: pick.decoration.clone(),
                point: world.to_array(),
                local_point: local.to_array(),
            });
        }
        true
    }
    pub(super) fn scene_press(
        &mut self,
        secondary: bool,
        pick: Option<interaction::ScenePick>,
        shift: bool,
    ) -> Result<()> {
        use space_native::{commands::Command, entity_edit as tree, selection::ComponentSelection};
        if let Some(pick) = &pick {
            if !secondary && let Some(source_id) = self.interface.attach_source.clone() {
                let source = self
                    .editor
                    .entities
                    .iter()
                    .position(|e| e.id == source_id)
                    .context("Source no longer exists")?;
                let target = self
                    .editor
                    .entities
                    .iter()
                    .position(|e| e.id == pick.entity)
                    .context("Target no longer exists")?;
                self.editor.attach_entity(target, source, &pick.component)?;
                self.interface.attach_source = None;
                self.audio.effect(
                    super::audio::Effect::Glue,
                    self.interface.preferences.effects,
                );
                self.status = "Attached · Cmd/Ctrl+Z to undo".into();
                return Ok(());
            }
            if self.active_tool == HotbarTool::Hammer
                && !secondary
                && self.interface.placement.is_none()
            {
                anyhow::ensure!(
                    self.editor.clipboard.is_some(),
                    "Choose an Item in the backpack first"
                );
                let point = pick
                    .hit
                    .model
                    .transform_point3(
                        (pick.hit.local_point + pick.hit.local_normal * 0.002).as_vec3(),
                    )
                    .as_dvec3();
                self.interface.placement = Some(space_native::ui_state::Placement {
                    position: interaction::snap(point, self.editor.micro),
                    rotation: DQuat::IDENTITY,
                    parent: if shift {
                        Some((pick.entity.clone(), pick.component.clone()))
                    } else {
                        None
                    },
                });
                self.capture_request = Some(false);
                return Ok(());
            }
            let index = self
                .editor
                .entities
                .iter()
                .position(|e| e.id == pick.entity)
                .context("Entity no longer exists")?;
            self.editor.selected_entity = Some(index);
            self.interface.component = Some(pick.component.clone());
            self.interface.decoration = pick.decoration.clone();
            if self.active_tool == HotbarTool::Wrench && secondary {
                self.interface.context_menu = Some(space_native::ui_state::ContextMenu {
                    position: [-1.0, -1.0],
                    entity: Some(pick.entity.clone()),
                    component: Some(pick.component.clone()),
                    confirm_delete: false,
                });
                self.editor.component_selection = Some(ComponentSelection {
                    entity: pick.entity.clone(),
                    component: pick.component.clone(),
                    a: glam::IVec3::ZERO,
                    b: glam::IVec3::ZERO,
                    micro: self.editor.micro,
                    all: true,
                    extra: Vec::new(),
                });
                self.capture_request = Some(false);
                return Ok(());
            }
            if self.active_tool == HotbarTool::Select && !secondary && pick.decoration.is_none() {
                let p = ((pick.hit.local_point - pick.hit.local_normal * 0.002)
                    * if self.editor.micro { 8.0 } else { 1.0 })
                .floor()
                .as_ivec3();
                self.editor.selection = None;
                self.editor.connected_selection = None;
                if shift
                    && let Some(selection) = &mut self.editor.component_selection
                    && selection.entity == pick.entity
                    && selection.component == pick.component
                    && selection.micro == self.editor.micro
                {
                    if let Some(i) = selection.extra.iter().position(|q| *q == p) {
                        selection.extra.remove(i);
                    } else {
                        selection.extra.push(p);
                    }
                } else if self.selecting
                    && let Some(selection) = &mut self.editor.component_selection
                    && selection.entity == pick.entity
                    && selection.component == pick.component
                {
                    selection.b = p;
                    self.selecting = false;
                } else {
                    self.editor.component_selection = Some(ComponentSelection {
                        entity: pick.entity.clone(),
                        component: pick.component.clone(),
                        a: p,
                        b: p,
                        micro: self.editor.micro,
                        all: false,
                        extra: Vec::new(),
                    });
                    self.selecting = true;
                }
                return Ok(());
            }
            if matches!(
                self.active_tool,
                HotbarTool::Brush | HotbarTool::Shovel | HotbarTool::Spoon
            ) && pick.decoration.is_none()
            {
                let micro = self.active_tool == HotbarTool::Spoon || self.editor.micro;
                let p = ((pick.hit.local_point
                    + pick.hit.local_normal
                        * if secondary && self.active_tool != HotbarTool::Brush {
                            0.002
                        } else {
                            -0.002
                        })
                    * if micro { 8.0 } else { 1.0 })
                .floor()
                .as_ivec3();
                let mut selection = ComponentSelection {
                    entity: pick.entity.clone(),
                    component: pick.component.clone(),
                    a: p,
                    b: p,
                    micro,
                    all: false,
                    extra: Vec::new(),
                };
                if self.active_tool == HotbarTool::Brush && secondary {
                    if let Some(mut first) = self.interface.brush_corner.take() {
                        anyhow::ensure!(
                            first.entity == pick.entity && first.component == pick.component,
                            "Choose both corners in the same component"
                        );
                        first.b = p;
                        selection = first;
                    } else {
                        self.interface.brush_corner = Some(selection);
                        self.status = "Brush 1/2 · right-click the opposite corner".into();
                        return Ok(());
                    }
                } else {
                    if self.held_tool.is_none() {
                        self.editor.begin_stroke();
                        self.held_tool = Some(secondary);
                    }
                    let radius = (self.editor.brush - 1).max(0);
                    selection.a -= glam::IVec3::splat(radius);
                    selection.b += glam::IVec3::splat(radius);
                }
                let shape = self.editor.selection_shape;
                self.editor.selection_shape = Default::default();
                self.editor.component_selection = Some(selection);
                let result = self.editor.command(
                    &mut self.world,
                    if self.active_tool == HotbarTool::Brush {
                        Command::Paint
                    } else if secondary {
                        Command::Fill
                    } else {
                        Command::Erase
                    },
                );
                self.editor.selection_shape = shape;
                self.status = result?;
                return Ok(());
            }
            if self.active_tool == HotbarTool::Model {
                anyhow::ensure!(
                    !self.editor.entities[index].running,
                    "Stop the entity before modeling"
                );
                let snapshot = self.editor.entities[index].clone();
                let root = snapshot.definition.root.as_ref().unwrap();
                let model = tree::pose(&snapshot) * tree::matrix(root, &pick.component).unwrap();
                let hit_world = pick
                    .hit
                    .model
                    .transform_point3(pick.hit.local_point.as_vec3())
                    .as_dvec3();
                let p = model.inverse().transform_point3(hit_world);
                let id = if secondary {
                    uuid::Uuid::new_v4().to_string()
                } else {
                    pick.decoration
                        .clone()
                        .context("Aim at a decoration to move it")?
                };
                if secondary {
                    let node = tree::find_mut(
                        self.editor.entities[index]
                            .definition
                            .root
                            .as_mut()
                            .unwrap(),
                        &pick.component,
                    )
                    .unwrap();
                    node.decorations.push(pb::Decoration {
                        id: id.clone(),
                        position: Some(tree::pb_vector(p)),
                        scale: Some(tree::pb_vector(DVec3::from_array(
                            self.model_size.map(f64::from),
                        ))),
                        color_rgb: self.editor.rgb,
                        material_id: self.editor.material,
                        ..Default::default()
                    });
                    if let Err(e) =
                        protocol::validate_entity(&self.editor.entities[index].definition)
                    {
                        self.editor.entities[index] = snapshot;
                        return Err(e);
                    }
                    self.editor.revision += 1;
                }
                self.interface.decoration = Some(id.clone());
                self.model_drag = Some(ModelDrag {
                    snapshot,
                    component: pick.component.clone(),
                    decoration: id,
                    local_to_world: model,
                    origin: p,
                    plane_point: hit_world,
                    plane_normal: self.view().1,
                    create: secondary,
                });
                self.status = "Drag to transform · release to confirm · Esc cancels".into();
                return Ok(());
            }
        }
        if self.active_tool == HotbarTool::Select {
            if secondary {
                self.dispatch(Command::Clear);
                return Ok(());
            }
            if let Some(hit) = self.hit() {
                let p = ((hit.point - hit.normal * 0.002)
                    * if self.editor.micro { 8.0 } else { 1.0 })
                .floor()
                .as_ivec3();
                let cell = space_native::world::Cell::new(p.x, p.y, p.z, self.editor.micro);
                self.editor.component_selection = None;
                if shift {
                    let count = self.editor.select_connected(&self.world, cell)?;
                    self.status = format!("Selected {count} connected voxels");
                    self.selecting = false;
                } else {
                    self.editor.connected_selection = None;
                    if self.selecting
                        && let Some((a, _)) = self.editor.selection
                    {
                        self.editor.selection = Some((a, cell));
                        self.selecting = false;
                    } else {
                        self.editor.selection = Some((cell, cell));
                        self.selecting = true;
                    }
                }
            }
            return Ok(());
        }
        if self.active_tool == HotbarTool::Brush && secondary {
            self.interface.brush_corner = None;
            self.status = "Right-click two corners on a stopped entity to dye a region".into();
            return Ok(());
        }
        let result = self.tool_press(secondary, pick.map(|p| (p.entity, p.hit.distance)));
        if result.is_ok()
            && self.active_tool == HotbarTool::Hammer
            && self.interface.placement.is_some()
        {
            self.capture_request = Some(false);
        }
        result
    }
    fn update_model_drag(&mut self) {
        use space_native::entity_edit as tree;
        let Some(drag) = &self.model_drag else {
            return;
        };
        let (eye, direction) = self.view();
        let denominator = direction.dot(drag.plane_normal);
        if denominator.abs() < 0.05 {
            return;
        }
        let distance = (drag.plane_point - eye).dot(drag.plane_normal) / denominator;
        if !(0.0..200.0).contains(&distance) {
            return;
        }
        let point = drag
            .local_to_world
            .inverse()
            .transform_point3(eye + direction * distance);
        let delta = point - drag.origin;
        let Some(e) = self
            .editor
            .entities
            .iter_mut()
            .find(|e| e.id == drag.snapshot.id)
        else {
            return;
        };
        let Some(node) = e
            .definition
            .root
            .as_mut()
            .and_then(|r| tree::find_mut(r, &drag.component))
        else {
            return;
        };
        let Some(d) = node
            .decorations
            .iter_mut()
            .find(|d| d.id == drag.decoration)
        else {
            return;
        };
        if drag.create && delta.length() > 0.03 {
            d.scale = Some(tree::pb_vector(
                delta.abs().clamp(DVec3::splat(0.01), DVec3::splat(256.0)),
            ));
            d.position = Some(tree::pb_vector((drag.origin + point) * 0.5));
        } else if !drag.create
            && let Some(before) = drag
                .snapshot
                .definition
                .root
                .as_ref()
                .and_then(|r| tree::find(r, &drag.component))
                .and_then(|c| c.decorations.iter().find(|d| d.id == drag.decoration))
        {
            d.position = Some(tree::pb_vector(
                (tree::vector(before.position.as_ref()) + delta)
                    .clamp(DVec3::splat(-512.0), DVec3::splat(512.0)),
            ));
        }
        self.editor.revision += 1;
    }
    pub(super) fn decoration_command(&mut self, delete: bool) -> Result<()> {
        use space_native::entity_edit as tree;
        let index = self
            .editor
            .selected_entity
            .context("Select a decoration first")?;
        let component = self
            .interface
            .component
            .clone()
            .context("Select a component")?;
        let id = self
            .interface
            .decoration
            .clone()
            .context("Select a decoration")?;
        let mut new_id = None;
        self.editor.update_entity(index, |e| {
            anyhow::ensure!(!e.running, "Stop the entity before modeling");
            let node = tree::find_mut(e.definition.root.as_mut().unwrap(), &component)
                .context("Component no longer exists")?;
            let i = node
                .decorations
                .iter()
                .position(|d| d.id == id)
                .context("Decoration no longer exists")?;
            if delete {
                node.decorations.remove(i);
            } else {
                let mut d = node.decorations[i].clone();
                d.id = uuid::Uuid::new_v4().to_string();
                let p = tree::vector(d.position.as_ref()) + DVec3::X * 0.5;
                d.position = Some(tree::pb_vector(p));
                new_id = Some(d.id.clone());
                node.decorations.push(d);
            }
            Ok(())
        })?;
        self.interface.decoration = new_id;
        Ok(())
    }
}

impl Game {
    pub(super) fn toggle_seat(&mut self, picked: Option<interaction::ScenePick>) -> Result<()> {
        if let Some(driver) = self.driver.take() {
            if let Some(state) = self
                .runtime_frame
                .as_ref()
                .and_then(|f| f.entities.iter().find(|e| e.id == driver.id))
            {
                let center = DVec3::from_array(state.position);
                let seat = state
                    .nodes
                    .iter()
                    .find(|n| n.id == driver.component)
                    .and_then(|n| n.seats.iter().find(|s| s.index == driver.seat));
                let q = seat.map_or(DQuat::IDENTITY, |s| DQuat::from_array(s.rotation));
                let mut right = q * DVec3::X;
                right.y = 0.0;
                right = right.normalize_or(DVec3::X);
                let mut radius = 1.0_f64;
                if let Some(root) = self
                    .editor
                    .entities
                    .iter()
                    .find(|e| e.id == driver.id)
                    .and_then(|e| e.definition.root.as_ref())
                {
                    for node in &state.nodes {
                        if let Some(c) = space_native::entity_edit::find(root, &node.id) {
                            let matrix = Mat4::from_cols_array(&node.model).as_dmat4();
                            for b in &c.blocks {
                                let v = interaction::voxel(b);
                                radius = radius.max(
                                    matrix
                                        .transform_point3(
                                            DVec3::new(v[0], v[1], v[2]) + DVec3::splat(v[3] * 0.5),
                                        )
                                        .distance(center)
                                        + v[3] * 0.866,
                                );
                            }
                        }
                    }
                }
                self.camera.position = center + right * (radius + 0.85);
                self.camera.velocity = DVec3::from_array(state.velocity);
                self.camera.grounded = false;
            }
            self.status = "Left the driver seat".into();
            return Ok(());
        }
        let pick = picked.context("Aim at an entity with a configured seat, then press V")?;
        let point = pick
            .hit
            .model
            .as_dmat4()
            .transform_point3(pick.hit.local_point);
        let state = self
            .runtime_frame
            .as_ref()
            .and_then(|f| f.entities.iter().find(|e| e.id == pick.entity))
            .context("Entity is still loading")?;
        let (node, seat) = state
            .nodes
            .iter()
            .flat_map(|n| n.seats.iter().map(move |s| (n, s)))
            .min_by(|(_, a), (_, b)| {
                DVec3::from_array(a.position)
                    .distance_squared(point)
                    .total_cmp(&DVec3::from_array(b.position).distance_squared(point))
            })
            .context("This entity has no seats")?;
        self.driver = Some(Driver {
            id: state.id.clone(),
            component: node.id.clone(),
            seat: seat.index,
        });
        self.camera.velocity = DVec3::ZERO;
        self.status = "Mounted · script controls · V to leave".into();
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use space_native::{
        editor::PlacedEntity,
        world::{Cell, Chunk, Manifest},
    };
    fn game() -> Game {
        let root = std::env::temp_dir().join(format!("space-tools-{}", uuid::Uuid::new_v4()));
        let dir = root.join("data/worlds/fixture");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&Manifest {
                schema: 1,
                world: "fixture".into(),
                seed: 42,
                generator: 1,
                spawn: [4.0, 4.0, 4.0],
                source_hash: "fixture".into(),
            })
            .unwrap(),
        )
        .unwrap();
        let mut g = Game::open(&root, "fixture").unwrap();
        g.world.insert((0, 0), Chunk::empty());
        g.camera = Camera::new(DVec3::new(4.5, 4.5, 8.0));
        g.camera.pitch = 0.0;
        g.world.set(
            Cell::new(4, 4, 4, false),
            space_native::world::color(0x123456, 0),
        );
        g
    }
    fn entity(g: &mut Game) -> String {
        let definition = pb::Entity {
            root: Some(pb::Component {
                id: "root".into(),
                name: "Test".into(),
                body: Some(pb::BodyConfig {
                    r#type: 1,
                    ..Default::default()
                }),
                blocks: vec![pb::Voxel {
                    color_rgb: 0x123456,
                    ..Default::default()
                }],
                ..Default::default()
            }),
            constraints: Vec::new(),
        };
        let e = PlacedEntity::new(definition, DVec3::new(4.0, 4.0, 4.0));
        let id = e.id.clone();
        g.editor.entities.push(e);
        id
    }
    #[test]
    fn assembling_keeps_controls_and_c_edits_only_the_aimed_entity() {
        let mut g = game();
        let unrelated = entity(&mut g);
        g.editor.selected_entity = Some(0);
        g.panel_open = false;
        let cell = Cell::new(4, 4, 4, false);
        g.editor.selection = Some((cell, cell));
        g.assemble_selection().unwrap();
        assert!(!g.panel_open && g.capture_request.is_none());
        assert!(g.status.contains("press C"));
        assert!(!g.editor.entities[1].running);
        g.open_entity_editor(None);
        assert!(!g.panel_open && g.capture_request.is_none());
        let id = g.editor.entities[1].id.clone();
        assert_ne!(id, unrelated);
        g.open_entity_editor(Some((id, 4.0)));
        assert!(g.panel_open && g.capture_request == Some(false));
        assert_eq!(g.editor.selected_entity, Some(1));
    }
    #[test]
    fn spoon_carve_is_one_atomic_undo_and_brush_samples() {
        let mut g = game();
        g.choose_tool(HotbarTool::Spoon);
        g.tool_press(false, None).unwrap();
        g.end_tool(false);
        assert_eq!(g.world.get(Cell::new(4, 4, 4, false)), 0);
        assert_eq!(g.world.chunks[&(0, 0)].micro.len(), 511);
        assert_eq!(g.editor.undo.len(), 1);
        g.editor.undo(&mut g.world);
        assert_eq!(g.world.get(Cell::new(4, 4, 4, false)), 0x01123456);
        assert!(g.world.chunks[&(0, 0)].micro.is_empty());
        g.choose_tool(HotbarTool::Brush);
        g.tool_press(true, None).unwrap();
        assert_eq!(g.editor.rgb, 0x123456);
    }
    #[test]
    fn selection_hammer_preview_and_commit_use_the_same_anchor() {
        let mut g = game();
        g.choose_tool(HotbarTool::Select);
        g.tool_press(false, None).unwrap();
        g.tool_press(false, None).unwrap();
        g.editor.copy_selection(&g.world).unwrap();
        g.choose_tool(HotbarTool::Hammer);
        let p = g.placement();
        let revision = g.world.revision;
        let parts = interaction::resource_parts(g.editor.clipboard.as_ref().unwrap());
        assert_eq!(parts.len(), 1);
        assert_eq!(g.world.revision, revision);
        g.tool_press(false, None).unwrap();
        assert_eq!(g.world.revision, revision);
        assert!(g.interface.placement.is_some());
        g.confirm_placement().unwrap();
        let c = Cell::new(p.x as i32, p.y as i32, p.z as i32, false);
        assert_ne!(g.world.get(c), 0);
        g.editor.undo(&mut g.world);
        assert_eq!(g.world.get(c), 0);
    }
    #[test]
    fn wrench_move_cancel_and_double_click_run_preserve_definition() {
        let mut g = game();
        let id = entity(&mut g);
        let original = g.editor.entities[0].position;
        let definition = g.editor.entities[0].definition.clone();
        g.choose_tool(HotbarTool::Wrench);
        g.tool_press(false, Some((id.clone(), 3.0))).unwrap();
        g.camera.position.x += 2.0;
        g.update_grab();
        assert_ne!(g.editor.entities[0].position, original);
        g.end_tool(true);
        assert_eq!(g.editor.entities[0].position, original);
        g.tool_press(false, Some((id.clone(), 3.0))).unwrap();
        g.end_tool(false);
        g.tool_press(false, Some((id, 3.0))).unwrap();
        assert!(g.editor.entities[0].running);
        assert_eq!(g.editor.entities[0].definition, definition);
        space_native::protocol::validate_entity(&g.editor.entities[0].definition).unwrap();
    }
    #[test]
    fn modeling_and_view_are_local_and_save_compatible() {
        let mut g = game();
        entity(&mut g);
        g.editor.selected_entity = Some(0);
        g.choose_tool(HotbarTool::Model);
        let before = g.editor.entities.clone();
        let pick = interaction::ScenePick {
            entity: g.editor.entities[0].id.clone(),
            component: "root".into(),
            decoration: None,
            hit: interaction::MeshPick {
                key: String::new(),
                distance: 3.0,
                local_point: DVec3::new(0.5, 0.5, 1.0),
                local_normal: DVec3::Z,
                model: Mat4::from_translation(Vec3::new(4.0, 4.0, 4.0)),
            },
        };
        g.scene_press(true, Some(pick.clone()), false).unwrap();
        g.camera.yaw += 0.08;
        g.update_model_drag();
        g.end_tool(true);
        assert_eq!(
            g.editor.entities, before,
            "Esc must restore a modeling drag without history"
        );
        g.scene_press(true, Some(pick), false).unwrap();
        g.camera.yaw += 0.08;
        g.update_model_drag();
        g.end_tool(false);
        assert_eq!(g.editor.undo.len(), 1, "create and drag must be one undo");
        g.editor.undo(&mut g.world);
        assert_eq!(g.editor.entities, before);
        g.editor.redo(&mut g.world);
        assert_eq!(
            g.editor.entities[0]
                .definition
                .root
                .as_ref()
                .unwrap()
                .decorations
                .len(),
            1
        );
        space_native::protocol::validate_entity(&g.editor.entities[0].definition).unwrap();
        g.perspective = 2;
        let (eye, dir) = g.view();
        assert!(eye.is_finite() && dir.is_finite());
        assert!((dir.length() - 1.0).abs() < 1e-9);
        g.save().unwrap();
        let s = storage::load(&g.save_path, "fixture", "fixture").unwrap();
        assert_eq!(s.perspective, 2);
    }
}
