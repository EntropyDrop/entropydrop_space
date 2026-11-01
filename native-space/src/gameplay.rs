use super::*;
use glam::{DQuat, Quat, Vec3};
use space_native::{protocol::inventory as pb, world::Hit};

pub(super) struct Grab {
    id: String,
    before: [f64; 3],
    rotation: [f64; 4],
    offset: DVec3,
    pub distance: f64,
}
impl Game {
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
        let distance = self
            .world
            .raycast(target, offset, 4.5)
            .map_or(4.5, |h| (h.distance - 0.3).max(0.3));
        let eye = target + offset * distance;
        (eye, (target - eye).normalize())
    }
    pub(super) fn hit(&self) -> Option<Hit> {
        let (eye, direction) = self.view();
        self.world.raycast(eye, direction, 50.0)
    }
    pub(super) fn placement(&self) -> DVec3 {
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
        self.editor.end_stroke();
        self.held_tool = None;
        if cancel {
            self.last_grab_click = None;
        }
        if let Some(grab) = self.grab.take()
            && cancel
            && let Some(e) = self.editor.entities.iter_mut().find(|e| e.id == grab.id)
        {
            e.position = grab.before;
            e.rotation = grab.rotation;
            self.editor.revision += 1;
            self.status = "Move cancelled".into();
        }
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
                    self.choose_tool(HotbarTool::Select);
                } else {
                    self.paste_at_cursor()?;
                    self.status = "Placed locally".into();
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
                        self.panel = Panel::Entities;
                        self.panel_open = true;
                        self.capture_request = Some(false);
                        return Ok(());
                    }
                    let double = self.last_grab_click.as_ref().is_some_and(|(last, time)| {
                        last == &id && time.elapsed().as_secs_f32() < 0.3
                    });
                    self.last_grab_click = Some((id.clone(), Instant::now()));
                    let e = &mut self.editor.entities[index];
                    if double {
                        e.running = !e.running;
                        self.editor.revision += 1;
                        self.last_grab_click = None;
                    } else if !e.running {
                        self.grab = Some(Grab {
                            id,
                            before: e.position,
                            rotation: e.rotation,
                            offset: DVec3::from_array(e.position) - (eye + dir * distance),
                            distance,
                        });
                    } else {
                        self.status = "Double-click to stop before moving this entity".into();
                    }
                }
            }
            HotbarTool::Model => {
                if secondary {
                    self.panel = Panel::Entities;
                    self.panel_open = true;
                    self.capture_request = Some(false);
                    return Ok(());
                }
                let position = self.placement();
                let e = self
                    .editor
                    .selected_entity
                    .and_then(|i| self.editor.entities.get_mut(i))
                    .context("Select an entity with Wrench first")?;
                anyhow::ensure!(!e.running, "Stop the entity before modeling");
                let root = e.definition.root.as_mut().context("Entity has no root")?;
                let world = glam::DMat4::from_rotation_translation(
                    DQuat::from_array(e.rotation),
                    DVec3::from_array(e.position),
                ) * interaction::component_matrix(root).as_dmat4();
                let p = world.inverse().transform_point3(position);
                anyhow::ensure!(root.decorations.len() < 1024, "Decoration limit reached");
                root.decorations.push(pb::Decoration {
                    id: uuid::Uuid::new_v4().to_string(),
                    position: Some(pb::Vector3 {
                        x: p.x,
                        y: p.y,
                        z: p.z,
                    }),
                    scale: Some(pb::Vector3 {
                        x: self.model_size[0] as f64,
                        y: self.model_size[1] as f64,
                        z: self.model_size[2] as f64,
                    }),
                    color_rgb: self.editor.rgb,
                    material_id: self.editor.material,
                    ..Default::default()
                });
                self.editor.revision += 1;
                self.status = "Decorative cube added to selected entity".into();
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
    pub(super) fn rotate_tool(&mut self) {
        if self.active_tool == HotbarTool::Hammer {
            let r = self.editor.rotate_clipboard();
            self.result(r);
            self.preview_dirty = true;
        } else if let Some(grab) = &self.grab
            && let Some(e) = self.editor.entities.iter_mut().find(|e| e.id == grab.id)
        {
            e.rotation = (DQuat::from_rotation_y(std::f64::consts::FRAC_PI_2)
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
            self.stamp(secondary);
        }
        self.update_grab();
        let preview = self.active_tool == HotbarTool::Hammer && self.editor.clipboard.is_some();
        if self.preview_dirty {
            renderer.meshes.retain(|k, _| !k.starts_with("preview:"));
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
            renderer.meshes.retain(|k, _| !k.starts_with("preview:"));
            self.preview_parts.clear();
        }
        if self.avatar_mode != Some(self.perspective) {
            renderer.meshes.retain(|k, _| !k.starts_with("avatar:"));
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
            for (i, model) in self
                .avatar
                .models(
                    (self.camera.position - DVec3::Y * 1.65).as_vec3(),
                    self.camera.yaw as f32,
                    self.camera.pitch as f32,
                    self.avatar_phase,
                    moving,
                    self.driver.is_some(),
                )
                .into_iter()
                .enumerate()
            {
                renderer.set_model(&format!("avatar:{i}"), model);
            }
        }
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
        space_native::protocol::validate_entity(&g.editor.entities[0].definition).unwrap();
    }
    #[test]
    fn modeling_and_view_are_local_and_save_compatible() {
        let mut g = game();
        entity(&mut g);
        g.editor.selected_entity = Some(0);
        g.choose_tool(HotbarTool::Model);
        g.tool_press(false, None).unwrap();
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
