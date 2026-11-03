//! Offline desktop UI, with the same layout and commands as the Web client.
use super::*;
use egui::{Color32, RichText, Stroke};
use space_native::{
    backpack::{Category, name},
    commands::Command,
    entity_edit as tree, palette,
    protocol::inventory as pb,
    selection::Shape,
    ui_state::{EditorTab, Modal},
};
const GREEN: Color32 = Color32::from_rgb(92, 255, 92);
fn frame() -> egui::Frame {
    egui::Frame::new()
        .fill(Color32::from_rgba_unmultiplied(18, 18, 20, 235))
        .stroke(Stroke::new(1.0_f32, Color32::from_white_alpha(40)))
        .inner_margin(12)
}
fn color(rgb: u32) -> Color32 {
    Color32::from_rgb((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8)
}
fn gizmo_axis(
    ctx: &egui::Context,
    axis: usize,
    center: egui::Pos2,
    end: egui::Pos2,
    tint: Color32,
) -> egui::Response {
    let hit_rect = egui::Rect::from_two_pos(center + (end - center) * 0.2, end).expand(6.0);
    // Each axis owns its actual screen rectangle. An empty Area at (0, 0)
    // can paint these lines, but egui cannot hit-test widgets outside it.
    egui::Area::new(egui::Id::new(("transform-gizmo", axis)))
        .fixed_pos(hit_rect.min)
        .movable(false)
        .constrain(false)
        .order(egui::Order::Middle)
        .show(ctx, |ui| {
            let (_, response) = ui.allocate_exact_size(hit_rect.size(), egui::Sense::drag());
            ui.painter().line_segment(
                [center, end],
                Stroke::new(if response.hovered() { 4.0_f32 } else { 2.5 }, tint),
            );
            ui.painter().circle_filled(end, 5.0, tint);
            ui.painter().text(
                end + egui::vec2(6.0, -6.0),
                egui::Align2::LEFT_BOTTOM,
                ["X", "Y", "Z"][axis],
                egui::FontId::proportional(14.0),
                tint,
            );
            response
        })
        .inner
}

impl Game {
    pub(super) fn dispatch(&mut self, command: Command) {
        if self.selecting
            && matches!(
                command,
                Command::Copy
                    | Command::Cut
                    | Command::Erase
                    | Command::Fill
                    | Command::Paint
                    | Command::Assemble
            )
        {
            self.status = "Click the second corner to confirm the selection first".into();
            return;
        }
        self.end_tool(false);
        let restore = if matches!(command, Command::Copy | Command::CopyEntity) {
            let posed = self.copy_pose_snapshot();
            Some(std::mem::replace(&mut self.editor.entities, posed))
        } else {
            None
        };
        let result = self.editor.command(&mut self.world, command);
        if let Some(authored) = restore {
            self.editor.entities = authored;
        }
        match result {
            Ok(message) => {
                self.audio.effect(
                    match command {
                        Command::Erase | Command::Cut | Command::DeleteEntity => {
                            audio::Effect::Break
                        }
                        Command::Assemble | Command::Disassemble => audio::Effect::Assemble,
                        Command::Fill => audio::Effect::Place,
                        _ => audio::Effect::Click,
                    },
                    self.interface.preferences.effects,
                );
                self.status = message;
                self.selecting = false;
                self.preview_dirty = true;
                if matches!(
                    command,
                    Command::Copy | Command::Cut | Command::CopyEntity | Command::CutEntity
                ) {
                    self.choose_tool(HotbarTool::Hammer);
                }
            }
            Err(e) => self.status = e.to_string(),
        }
    }
    fn copy_pose_snapshot(&self) -> Vec<space_native::editor::PlacedEntity> {
        let mut entities = self.editor.entities.clone();
        for e in &mut entities {
            if !e.running {
                continue;
            }
            let Some(state) = self
                .runtime_frame
                .as_ref()
                .and_then(|f| f.entities.iter().find(|s| s.id == e.id))
            else {
                continue;
            };
            let Some(root) = e.definition.root.as_mut() else {
                continue;
            };
            tree::freeze_pivots(root);
            let Some(runtime_root) = state.nodes.iter().find(|n| n.id == root.id) else {
                continue;
            };
            let world = Mat4::from_cols_array(&runtime_root.model).as_dmat4();
            let (_, q, p) = world.to_scale_rotation_translation();
            e.position = p.to_array();
            e.rotation = q.to_array();
            e.running = false;
            fn apply(
                node: &mut pb::Component,
                parent: Option<glam::DMat4>,
                state: &runtime::EntityState,
                geometry: &HashMap<String, Vec<[f64; 6]>>,
            ) {
                let Some(n) = state.nodes.iter().find(|n| n.id == node.id) else {
                    return;
                };
                let model = Mat4::from_cols_array(&n.model).as_dmat4();
                let pivot = tree::vector(node.pivot.as_ref());
                let frame = model * glam::DMat4::from_translation(pivot);
                if let Some(parent) = parent {
                    let (_, q, p) = (parent.inverse() * frame).to_scale_rotation_translation();
                    node.local_position = Some(tree::pb_vector(p));
                    node.local_rotation = Some(tree::pb_quaternion(tree::cube_rotation(q)));
                }
                if let Some(voxels) =
                    geometry.get(&interaction::entity_mesh_key(&state.id, &node.id))
                {
                    node.blocks = voxels
                        .iter()
                        .map(|v| {
                            space_native::editor::voxel_at(
                                DVec3::new(v[0], v[1], v[2]),
                                v[3] < 1.0,
                                space_native::world::color(v[4] as u32, v[5] as u32),
                                DVec3::ZERO,
                            )
                        })
                        .collect();
                }
                node.decorations = n
                    .decorations
                    .iter()
                    .map(|d| pb::Decoration {
                        id: d.id.clone(),
                        position: d
                            .position
                            .map(|p| tree::pb_vector(DVec3::from_array(p.map(f64::from)))),
                        rotation: d.rotation.map(|q| {
                            tree::pb_quaternion(glam::DQuat::from_array(q.map(f64::from)))
                        }),
                        scale: d
                            .scale
                            .map(|p| tree::pb_vector(DVec3::from_array(p.map(f64::from)))),
                        color_rgb: d.color,
                        material_id: d.material,
                    })
                    .collect();
                for child in &mut node.children {
                    apply(child, Some(frame), state, geometry);
                }
            }
            apply(root, None, state, &self.runtime_geometry);
        }
        entities
    }
    pub(super) fn open_modal(&mut self, modal: Modal) {
        self.end_tool(false);
        self.interface.open(modal);
        self.capture_request = Some(false);
    }
    pub(super) fn sync_palette(&mut self) {
        let entry = &self.interface.preferences.palette.entries
            [self.interface.preferences.palette.selected];
        self.editor.rgb = palette::sample(entry, 0.0);
        self.editor.material = entry.material_id;
        self.editor.gradient = Some(entry.clone());
    }
    pub(super) fn toggle_grid(&mut self) {
        if self.interface.placement.is_some() {
            return;
        }
        self.editor.micro = !self.editor.micro;
        if let Some(index) = match self.active_tool {
            HotbarTool::Select => Some(0),
            HotbarTool::Hammer => Some(1),
            HotbarTool::Brush => Some(2),
            _ => None,
        } {
            self.interface.preferences.tool_micro[index] = self.editor.micro;
        }
    }
    pub(super) fn equip(&mut self, category: Category, slot: usize) {
        let _ = self.editor.backpack.select(category, slot);
        if let Some(resource) = self.editor.backpack.get(category, slot).cloned() {
            if let Some(pb::inventory_resource::Content::ColorSet(set)) = resource.content.as_ref()
            {
                self.interface.preferences.palette.entries = set.entries.clone();
                self.interface.preferences.normalize();
                self.sync_palette();
            } else {
                self.editor.clipboard = Some(resource);
                self.choose_tool(HotbarTool::Hammer);
                self.preview_dirty = true;
            }
        } else if category == Category::Items {
            self.editor.clipboard = None;
            self.preview_dirty = true;
        }
        self.editor.revision += 1;
    }
    pub(super) fn desktop_ui(
        &mut self,
        ctx: &egui::Context,
        renderer: &Renderer,
        fps: f64,
        captured: bool,
    ) {
        egui::Area::new("world-hud".into())
            .fixed_pos([20.0, 16.0])
            .show(ctx, |ui| {
                frame().show(ui, |ui| {
                    ui.set_width(232.0);
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("EntropyDrop · Space").color(GREEN).strong());
                        ui.small(if self.ephemeral {
                            "VALIDATION"
                        } else {
                            "OFFLINE"
                        });
                    });
                    ui.label(format!(
                        "{fps:.0} FPS · {:.0}, {:.0}, {:.0}",
                        self.camera.position.x, self.camera.position.y, self.camera.position.z
                    ));
                    let total = self.near_demand.keys.len().max(1) as f32;
                    ui.add(
                        egui::ProgressBar::new((self.near_ready.len() as f32 / total).min(1.0))
                            .text(format!("Near terrain · {} chunks", self.near_ready.len())),
                    );
                    if ui
                        .selectable_label(
                            self.interface.nearby_open,
                            format!("Nearby entities  {}", self.editor.entities.len()),
                        )
                        .clicked()
                    {
                        self.interface.nearby_open = !self.interface.nearby_open;
                    }
                    if self.interface.nearby_open {
                        let mut nearby: Vec<_> = self
                            .editor
                            .entities
                            .iter()
                            .enumerate()
                            .map(|(i, e)| {
                                (
                                    i,
                                    e.name().to_owned(),
                                    DVec3::from_array(e.position).distance(self.camera.position),
                                )
                            })
                            .collect();
                        nearby.sort_by(|a, b| a.2.total_cmp(&b.2));
                        self.interface.nearby_page = self
                            .interface
                            .nearby_page
                            .min(nearby.len().saturating_sub(1) / 3);
                        for (i, name, distance) in nearby
                            .into_iter()
                            .skip(self.interface.nearby_page * 3)
                            .take(3)
                        {
                            if ui.button(format!("{name} · {distance:.0} m")).clicked() {
                                self.editor.selected_entity = Some(i);
                                self.interface.component = None;
                                self.open_modal(Modal::Editor);
                            }
                        }
                        ui.horizontal(|ui| {
                            if ui.small_button("<").clicked() {
                                self.interface.nearby_page =
                                    self.interface.nearby_page.saturating_sub(1);
                            }
                            ui.small(format!("Page {}", self.interface.nearby_page + 1));
                            if ui.small_button(">").clicked() {
                                self.interface.nearby_page += 1;
                            }
                        });
                    }
                });
            });
        egui::Area::new("quick-actions".into())
            .anchor(egui::Align2::RIGHT_TOP, [-20.0, 16.0])
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    for (label, modal) in [
                        ("?", Modal::Help),
                        ("Tutorial", Modal::Tutorial),
                        ("Settings", Modal::Settings),
                    ] {
                        if ui.button(label).clicked() {
                            self.open_modal(modal);
                        }
                    }
                });
            });
        let toolbelt = egui::Area::new("toolbelt".into())
            .anchor(egui::Align2::CENTER_BOTTOM, [0.0, -20.0])
            .show(ctx, |ui| {
                ui.set_width(548.0);
                frame().show(ui, |ui| self.tool_options(ui));
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    for (index, tool) in HotbarTool::ALL.into_iter().enumerate() {
                        let (rect, response) =
                            ui.allocate_exact_size(egui::vec2(72.0, 62.0), egui::Sense::click());
                        let selected = self.active_tool == tool;
                        ui.painter().rect_filled(
                            rect,
                            0.0,
                            if selected {
                                Color32::from_rgb(60, 133, 39)
                            } else {
                                Color32::from_rgba_unmultiplied(18, 18, 20, 235)
                            },
                        );
                        ui.painter().rect_stroke(
                            rect,
                            0.0,
                            Stroke::new(
                                1.0_f32,
                                if selected {
                                    GREEN
                                } else {
                                    Color32::from_white_alpha(45)
                                },
                            ),
                            egui::StrokeKind::Inside,
                        );
                        hud::icon(
                            ui.painter(),
                            rect.center() - egui::vec2(0.0, 7.0),
                            tool,
                            Color32::WHITE,
                        );
                        ui.painter().text(
                            rect.center_bottom() - egui::vec2(0.0, 10.0),
                            egui::Align2::CENTER_CENTER,
                            format!("{} {}", index + 1, tool.name()),
                            egui::FontId::proportional(11.0),
                            Color32::WHITE,
                        );
                        if response.clicked() {
                            self.choose_tool(tool);
                        }
                        response.on_hover_text(tool.hint());
                    }
                });
            });
        self.transform_gizmo(ctx, renderer);
        let auxiliary_bottom = ctx.input(|i| {
            if i.viewport_rect().width() < 1150.0 {
                toolbelt.response.rect.top() - i.viewport_rect().bottom() - 12.0
            } else {
                -20.0
            }
        });
        self.navigation_ui(ctx, auxiliary_bottom);
        self.minimap_ui(ctx);
        egui::Area::new("save-status".into())
            .anchor(egui::Align2::RIGHT_BOTTOM, [-16.0, auxiliary_bottom])
            .show(ctx, |ui| {
                ui.set_max_width(240.0);
                ui.small(&self.status);
                if ui
                    .small_button(if self.ephemeral {
                        "Validation · save disabled"
                    } else if self.editor.revision == self.saved_revision {
                        "Local · saved"
                    } else {
                        "Save changes"
                    })
                    .clicked()
                {
                    let r = self.save();
                    self.result(r);
                }
            });
        self.context_menu_ui(ctx);
        self.palette_ui(ctx);
        self.modals_ui(ctx, renderer);
        if !captured && self.interface.modal == Modal::None && self.interface.context_menu.is_none()
        {
            egui::Area::new("resume-hint".into())
                .anchor(egui::Align2::CENTER_TOP, [0.0, 20.0])
                .show(ctx, |ui| {
                    frame().show(ui, |ui| {
                        if ui
                            .button("Click the world or press Enter to play")
                            .clicked()
                        {
                            self.capture_request = Some(true);
                        }
                    });
                });
        }
    }
    fn tool_options(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.strong(self.active_tool.name());
            if matches!(
                self.active_tool,
                HotbarTool::Select | HotbarTool::Hammer | HotbarTool::Brush
            ) && ui
                .button(if self.editor.micro {
                    "MICRO · Tab"
                } else {
                    "STD · Tab"
                })
                .clicked()
            {
                self.toggle_grid();
            }
            if ui
                .add(egui::Button::new("Color · I").fill(color(self.editor.rgb)))
                .clicked()
            {
                self.interface.color_picker = !self.interface.color_picker;
                self.capture_request = Some(false);
            }
            if ui.button("Backpack · B").clicked() {
                self.open_modal(Modal::Backpack);
            }
        });
        match self.active_tool {
            HotbarTool::Select => {
                ui.horizontal(|ui| {
                    for shape in Shape::ALL {
                        ui.selectable_value(
                            &mut self.editor.selection_shape.shape,
                            shape,
                            shape.name(),
                        );
                    }
                });
                ui.horizontal(|ui| {
                    for (label, command) in [
                        ("G Assemble", Command::Assemble),
                        ("F Fill", Command::Fill),
                        ("P Paint", Command::Paint),
                        ("R Copy", Command::Copy),
                        ("X Cut", Command::Cut),
                        ("Del", Command::Erase),
                    ] {
                        if ui.small_button(label).clicked() {
                            self.dispatch(command);
                        }
                    }
                });
                ui.small(
                    "LMB: two corners · Shift+LMB: connected · Alt+1–5: shape · Arrows: rotate",
                );
            }
            HotbarTool::Hammer => {
                ui.small("Shift+LMB: attach Item to the aimed component");
                if self.interface.placement.is_some() {
                    ui.horizontal(|ui| {
                        ui.label("Pinned preview");
                        if ui.button("Build · Enter").clicked() {
                            let r = self.confirm_placement();
                            self.result(r);
                        }
                        if ui.button("Cancel · RMB").clicked() {
                            self.interface.placement = None;
                        }
                    });
                    if let Some(placement) = &mut self.interface.placement {
                        vector(ui, "Position", &mut placement.position, 0.125);
                    }
                } else {
                    ui.small("LMB: pin preview · Arrows: rotate · T: text · Enter: build");
                }
                ui.horizontal(|ui| {
                    for slot in 0..9 {
                        let name = self
                            .editor
                            .backpack
                            .get(Category::Items, slot)
                            .map_or(String::new(), name);
                        let response = ui.add_sized(
                            [51.0, 42.0],
                            egui::Button::new(format!("{}\n{}", slot + 1, abbreviate(&name, 5)))
                                .selected(self.editor.backpack.selected(Category::Items) == slot),
                        );
                        if response.clicked() {
                            self.equip(Category::Items, slot);
                        }
                        response.on_hover_text(name);
                    }
                });
            }
            HotbarTool::Wrench => {
                ui.small("Hold LMB: lift · Double click: run/stop · RMB: menu · C: edit");
                ui.horizontal(|ui| {
                    if ui.small_button("Attach to…").clicked()
                        && let Some(i) = self.editor.selected_entity
                    {
                        self.interface.attach_source = Some(self.editor.entities[i].id.clone());
                        self.capture_request = Some(true);
                        self.status = "Click the destination component · Esc cancels".into();
                    }
                    for (label, mode) in [
                        ("Move", space_native::ui_state::TransformMode::Translate),
                        ("Rotate", space_native::ui_state::TransformMode::Rotate),
                        ("Pivot", space_native::ui_state::TransformMode::Pivot),
                    ] {
                        ui.selectable_value(&mut self.interface.transform, mode, label);
                    }
                });
                ui.horizontal(|ui| {
                    for (label, command) in [
                        ("Run", Command::Start),
                        ("Stop", Command::Stop),
                        ("Copy", Command::CopyEntity),
                        ("Detach", Command::Detach),
                    ] {
                        if ui.small_button(label).clicked() {
                            self.dispatch(command);
                        }
                    }
                });
            }
            HotbarTool::Model => {
                ui.small("LMB: select · RMB: add cube · R: duplicate · Del: delete");
                ui.horizontal(|ui| {
                    for (i, axis) in ["X", "Y", "Z"].iter().enumerate() {
                        ui.add(
                            egui::DragValue::new(&mut self.model_size[i])
                                .speed(0.01)
                                .range(0.001..=256.0)
                                .prefix(*axis),
                        );
                    }
                });
                self.interface.preferences.modeling_size = self.model_size;
                ui.horizontal(|ui| {
                    for (mode, label) in [
                        (space_native::ui_state::TransformMode::Translate, "Move"),
                        (space_native::ui_state::TransformMode::Rotate, "Rotate"),
                        (space_native::ui_state::TransformMode::Scale, "Scale"),
                    ] {
                        ui.selectable_value(&mut self.interface.transform, mode, label);
                    }
                    if ui.button("Edit · C").clicked() {
                        self.interface.tab = EditorTab::Properties;
                        self.open_modal(Modal::Editor);
                    }
                });
            }
            HotbarTool::Brush => {
                ui.small("LMB: paint · RMB: two-point gradient · I: palette");
                ui.add(egui::Slider::new(&mut self.editor.brush, 1..=8).text("Brush size"));
            }
            _ => {
                ui.small(self.active_tool.hint());
                ui.add(egui::Slider::new(&mut self.editor.brush, 1..=8).text("Brush size"));
            }
        }
    }
    fn navigation_ui(&mut self, ctx: &egui::Context, bottom: f32) {
        egui::Area::new("navigation".into())
            .anchor(egui::Align2::LEFT_BOTTOM, [20.0, bottom])
            .show(ctx, |ui| {
                frame().show(ui, |ui| {
                    ui.set_width(224.0);
                    ui.collapsing("Navigation", |ui| {
                        for (i, axis) in ["X", "Y", "Z"].iter().enumerate() {
                            ui.horizontal(|ui| {
                                ui.label(*axis);
                                ui.add(
                                    egui::TextEdit::singleline(
                                        &mut self.interface.navigation_input[i],
                                    )
                                    .desired_width(160.0),
                                );
                            });
                        }
                        ui.horizontal(|ui| {
                            if ui.button("Fly to").clicked() {
                                let parsed: Option<Vec<f64>> = self
                                    .interface
                                    .navigation_input
                                    .iter()
                                    .map(|s| s.parse::<f64>().ok().filter(|x| x.is_finite()))
                                    .collect();
                                if let Some(p) = parsed {
                                    self.interface.navigation_target = Some(DVec3::new(
                                        p[0].rem_euclid(16384.0),
                                        p[1].clamp(2.0, 512.0),
                                        p[2].rem_euclid(2048.0),
                                    ));
                                    self.camera.flying = true;
                                } else {
                                    self.status = "Enter three finite coordinates".into();
                                }
                            }
                            if ui.button("Spawn").clicked() {
                                self.interface.navigation_target =
                                    Some(DVec3::from_array(self.world.source.manifest.spawn));
                                self.camera.flying = true;
                            }
                            if self.interface.navigation_target.is_some()
                                && ui.button("Stop").clicked()
                            {
                                self.interface.navigation_target = None;
                            }
                        });
                    });
                });
            });
    }
    fn palette_ui(&mut self, ctx: &egui::Context) {
        if !self.interface.color_picker {
            return;
        }
        let mut open = true;
        egui::Window::new("Palette · I")
            .id("color-picker".into())
            .open(&mut open)
            .default_width(420.0)
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    for i in 0..9 {
                        let rgb =
                            palette::sample(&self.interface.preferences.palette.entries[i], 0.0);
                        if ui
                            .add_sized(
                                [35.0, 35.0],
                                egui::Button::new(format!("{}", i + 1))
                                    .fill(color(rgb))
                                    .selected(self.interface.preferences.palette.selected == i),
                            )
                            .clicked()
                        {
                            self.interface.preferences.palette.selected = i;
                            self.interface.active_stop = 0;
                        }
                    }
                });
                let entry = &mut self.interface.preferences.palette.entries
                    [self.interface.preferences.palette.selected];
                ui.label("Gradient stops");
                let mut remove = None;
                for (i, stop) in entry.stops.iter_mut().enumerate() {
                    ui.horizontal(|ui| {
                        let mut rgb = [
                            (stop.color_rgb >> 16) as u8,
                            (stop.color_rgb >> 8) as u8,
                            stop.color_rgb as u8,
                        ];
                        ui.color_edit_button_srgb(&mut rgb);
                        stop.color_rgb = u32::from_be_bytes([0, rgb[0], rgb[1], rgb[2]]);
                        ui.add(
                            egui::Slider::new(&mut stop.offset_millis, 0..=1000).text("Position"),
                        );
                        if ui.small_button("×").clicked() {
                            remove = Some(i);
                        }
                    });
                }
                if let Some(i) = remove.filter(|_| entry.stops.len() > 1) {
                    entry.stops.remove(i);
                }
                if entry.stops.len() < 5 && ui.button("Add stop").clicked() {
                    entry.stops.push(pb::GradientStop {
                        color_rgb: 0xffffff,
                        offset_millis: 1000,
                    });
                }
                palette::normalize(entry);
                ui.horizontal(|ui| {
                    if ui
                        .selectable_label(entry.material_id == 0, "Solid")
                        .clicked()
                    {
                        entry.material_id = 0;
                    }
                    if ui
                        .selectable_label(entry.material_id == 1, "Emissive")
                        .clicked()
                    {
                        entry.material_id = 1;
                    }
                });
                let mut transparency = entry.material_id.saturating_sub(1);
                if ui
                    .add(egui::Slider::new(&mut transparency, 0..=100).text("Transparency %"))
                    .changed()
                {
                    entry.material_id = if transparency == 0 {
                        0
                    } else {
                        transparency + 1
                    };
                }
                if ui.button("Save color set to backpack").clicked() {
                    let r = self
                        .editor
                        .backpack
                        .insert(pb::InventoryResource {
                            schema_version: 8,
                            content: Some(pb::inventory_resource::Content::ColorSet(
                                pb::ColorSet {
                                    name: "Color set".into(),
                                    entries: self.interface.preferences.palette.entries.clone(),
                                    ..Default::default()
                                },
                            )),
                        })
                        .map(|_| ());
                    self.result(r);
                    self.editor.revision += 1;
                }
            });
        self.interface.color_picker = open;
        self.sync_palette();
    }
    fn context_menu_ui(&mut self, ctx: &egui::Context) {
        if let Some(menu) = &mut self.interface.context_menu
            && menu.position[0] < 0.0
        {
            let rect = ctx.input(|i| i.viewport_rect());
            let p = ctx.pointer_latest_pos().unwrap_or(rect.center());
            menu.position = [
                p.x.min(rect.right() - 230.0).max(10.0),
                p.y.min(rect.bottom() - 490.0).max(10.0),
            ];
        }
        let Some(menu) = self.interface.context_menu.clone() else {
            return;
        };
        egui::Area::new("entity-menu".into())
            .order(egui::Order::Foreground)
            .fixed_pos(menu.position)
            .show(ctx, |ui| {
                frame().show(ui, |ui| {
                    if ui.button("Edit · C").clicked() {
                        self.open_modal(Modal::Editor);
                    }
                    for (label, command) in [
                        ("Start", Command::Start),
                        ("Stop", Command::Stop),
                        ("Copy", Command::CopyEntity),
                        ("Cut", Command::CutEntity),
                        ("Duplicate", Command::Duplicate),
                        ("Reset rotation", Command::ResetRotation),
                        ("Disassemble", Command::Disassemble),
                        ("Detach component", Command::Detach),
                        ("Select all blocks", Command::SelectAll),
                    ] {
                        if ui.button(label).clicked() {
                            self.dispatch(command);
                            self.interface.context_menu = None;
                        }
                    }
                    if ui
                        .button(if menu.confirm_delete {
                            "Confirm delete"
                        } else {
                            "Delete…"
                        })
                        .clicked()
                    {
                        if menu.confirm_delete {
                            self.dispatch(Command::DeleteEntity);
                            self.interface.context_menu = None;
                        } else if let Some(menu) = &mut self.interface.context_menu {
                            menu.confirm_delete = true;
                        }
                    }
                    if ui.button("Cancel").clicked() {
                        self.interface.context_menu = None;
                    }
                });
            });
    }
}
fn abbreviate(s: &str, n: usize) -> String {
    let mut result: String = s.chars().take(n).collect();
    if s.chars().count() > n {
        result.push('…');
    }
    result
}
fn vector(ui: &mut egui::Ui, label: &str, p: &mut DVec3, speed: f64) -> bool {
    let mut changed = false;
    ui.label(label);
    ui.horizontal_wrapped(|ui| {
        for (axis, name) in ["X", "Y", "Z"].iter().enumerate() {
            changed |= ui
                .add(
                    egui::DragValue::new(&mut p[axis])
                        .speed(speed)
                        .prefix(*name),
                )
                .changed();
        }
    });
    changed
}
impl Game {
    pub(super) fn apply_scripts(&mut self) -> Result<()> {
        let mut changes = Vec::new();
        for (index, before) in self.editor.entities.iter().enumerate() {
            let mut after = before.clone();
            for ((id, component), script) in &self.interface.script_drafts {
                if id != &before.id {
                    continue;
                }
                if let Some(c) = after
                    .definition
                    .root
                    .as_mut()
                    .and_then(|root| tree::find_mut(root, component))
                {
                    c.script = if script.is_empty() {
                        None
                    } else {
                        Some(script.clone())
                    };
                    c.script_language = "assemblyscript".into();
                }
            }
            if after != *before {
                protocol::validate_entity(&after.definition)?;
                changes.push(space_native::editor::EntityChange {
                    index,
                    before: Some(before.clone()),
                    after: Some(after),
                });
            }
        }
        for change in &changes {
            self.editor.entities[change.index] = change.after.as_ref().unwrap().clone();
        }
        self.editor.record_entities(changes);
        Ok(())
    }
    pub(super) fn close_modal(&mut self) -> bool {
        if let Err(e) = self.apply_scripts() {
            self.status = e.to_string();
            return false;
        }
        self.editor.end_stroke();
        self.interface.modal = Modal::None;
        true
    }
    fn modals_ui(&mut self, ctx: &egui::Context, renderer: &Renderer) {
        let modal = self.interface.modal;
        if modal == Modal::None {
            return;
        }
        let title = match modal {
            Modal::Backpack => "Backpack",
            Modal::Editor => "Entity editor",
            Modal::Settings => "Settings",
            Modal::Help => "EntropyDrop · Space",
            Modal::Text => "Create text",
            Modal::ModelImport => "Import model",
            Modal::Tutorial => "Tutorial",
            Modal::ApiDocs => "Script API",
            Modal::None => return,
        };
        let available = ctx.input(|i| i.viewport_rect().size());
        let mut open = true;
        // The backdrop consumes scene clicks. Closing never forwards a click into the world.
        egui::Area::new("modal-backdrop".into())
            .order(egui::Order::Middle)
            .fixed_pos([0.0, 0.0])
            .show(ctx, |ui| {
                let (r, _) = ui.allocate_exact_size(available, egui::Sense::click());
                ui.painter()
                    .rect_filled(r, 0.0, Color32::from_black_alpha(130));
            });
        egui::Window::new(title).id(egui::Id::new(("primary-modal",modal as u8))).open(&mut open).order(egui::Order::Foreground).anchor(egui::Align2::CENTER_CENTER,[0.0,0.0]).default_width(match modal{Modal::Editor=>1100.0,Modal::Backpack=>980.0,_=>720.0}).max_width((available.x-40.0).max(280.0)).max_height((available.y-60.0).max(200.0)).resizable(true).collapsible(false).show(ctx,|ui|{
            egui::ScrollArea::vertical().max_height((available.y-180.0).clamp(180.0,760.0)).show(ui,|ui|match modal {
                Modal::Backpack=>self.backpack_modal(ui),
                Modal::Editor=>self.entity_modal(ui),
                Modal::Settings=>self.preferences_ui(ui,renderer),
                Modal::Help=>self.help_ui(ui),
                Modal::Text=>self.text_ui(ui),
                Modal::ModelImport=>self.model_import_ui(ui),
                Modal::Tutorial=>self.tutorial_ui(ui),
                Modal::ApiDocs=>{ui.heading("AssemblyScript API");ui.label("The source runs each simulation tick with self (Component) and ctx (Context). Store persistent values in self.state. Stop restores the authored construction pose.");ui.monospace(include_str!("../../engine/assembly/entity-sdk.ts"));},
                Modal::None=>{},
            });
            ui.separator();ui.small(&self.status);
        });
        if !open {
            self.close_modal();
        }
    }
    fn help_ui(&mut self, ui: &mut egui::Ui) {
        ui.label(RichText::new("SPACE").size(32.0).strong().color(GREEN));
        ui.label("Build, explore and create in your local world.");
        ui.add_space(12.0);
        egui::Grid::new("controls-help")
            .num_columns(2)
            .striped(true)
            .spacing([28.0, 10.0])
            .show(ui, |ui| {
                for (keys, action) in [
                    ("W A S D", "Move / drive"),
                    ("Space / Double Space", "Jump / toggle flight"),
                    ("Shift / Ctrl", "Sneak or descend / sprint"),
                    ("1–7 / Tab", "Tools / standard or micro grid"),
                    ("Alt+1–9 / I / B", "Palette slot / color picker / backpack"),
                    ("F / P / G", "Fill / paint / assemble selection"),
                    ("R / X / Delete", "Copy / cut / delete selection"),
                    ("Arrows", "Rotate tool or selection"),
                    ("LMB / Enter / RMB", "Hammer: pin preview / build / cancel"),
                    ("C / V", "Edit aimed entity / enter or leave seat"),
                    ("F3 or F5", "Change perspective"),
                    ("Cmd/Ctrl+Z / Shift+Z", "Undo / redo"),
                    ("Esc", "Close menu / release cursor"),
                ] {
                    ui.label(RichText::new(keys).color(GREEN));
                    ui.label(action);
                    ui.end_row();
                }
            });
        ui.add_space(12.0);
        ui.horizontal(|ui| {
            if ui
                .add_sized(
                    [180.0, 42.0],
                    egui::Button::new("Play").fill(Color32::from_rgb(60, 133, 39)),
                )
                .clicked()
                && self.close_modal()
            {
                self.capture_request = Some(true);
            }
            if ui.button("Tutorial").clicked() {
                self.interface.modal = Modal::Tutorial;
            }
        });
    }
    fn backpack_modal(&mut self, ui: &mut egui::Ui) {
        let mut category = self.editor.backpack.active();
        ui.horizontal(|ui| {
            ui.selectable_value(&mut category, Category::Items, "Items");
            ui.selectable_value(&mut category, Category::Colors, "Color sets");
            if ui.button("Text").clicked() {
                self.interface.modal = Modal::Text;
            }
            if ui.button("Import model").clicked() {
                self.interface.modal = Modal::ModelImport;
            }
        });
        self.editor.backpack.set_active(category);
        ui.separator();
        ui.label("Portable item (.edpb) or complete backpack (.edbp)");
        ui.horizontal_wrapped(|ui| {
            if ui.button("Import file…").clicked()
                && let Some(path) = file_dialog::open()
            {
                let r = self.import(&path);
                self.result(r);
            }
            if ui.button("Export selected…").clicked()
                && let Some(path) = file_dialog::save("item.edpb")
            {
                self.path = path.to_string_lossy().into_owned();
                let resource = self
                    .editor
                    .backpack
                    .get(category, self.editor.backpack.selected(category))
                    .cloned();
                let r = (|| {
                    let resource = resource.context("Select a filled slot")?;
                    std::fs::write(&self.path, protocol::encode(&resource)?)?;
                    Ok(())
                })();
                self.result(r);
            }
            if ui.button("Import backpack…").clicked()
                && let Some(path) = file_dialog::open()
            {
                self.path = path.to_string_lossy().into_owned();
                let r = (|| {
                    let bytes = std::fs::read(&self.path)?;
                    let bag = space_native::backpack::Backpack::decode(&bytes)?;
                    self.interface.pending_backpack = Some(bag);
                    Ok(())
                })();
                self.result(r);
            }
            if ui.button("Export backpack…").clicked()
                && let Some(path) = file_dialog::save("backpack.edbp")
            {
                self.path = path.to_string_lossy().into_owned();
                let r = (|| {
                    std::fs::write(&self.path, self.editor.backpack.encode()?)?;
                    Ok(())
                })();
                self.result(r);
            }
        });
        if self.interface.pending_backpack.is_some() {
            frame().show(ui, |ui| {
                ui.colored_label(
                    Color32::YELLOW,
                    "Replace the current backpack with this file? Export first to keep a backup.",
                );
                ui.horizontal(|ui| {
                    if ui.button("Replace backpack").clicked() {
                        self.editor.backpack = self.interface.pending_backpack.take().unwrap();
                        self.editor.revision += 1;
                    }
                    if ui.button("Cancel import").clicked() {
                        self.interface.pending_backpack = None;
                    }
                });
            });
        }
        ui.small(
            "Drag to move or swap. Click to equip. Right click to rename, duplicate or delete.",
        );
        let width = ((ui.available_width() - 48.0) / 9.0).clamp(38.0, 78.0);
        let mut selected = None;
        let mut remove = None;
        let mut duplicate = None;
        let mut swap = None;
        let mut draw_slots = |ui: &mut egui::Ui, range: std::ops::Range<usize>| {
            egui::Grid::new(("backpack-grid", range.start))
                .spacing([5.0, 5.0])
                .num_columns(9)
                .show(ui, |ui| {
                    for slot in range {
                        let resource = self.editor.backpack.get(category, slot);
                        let label = resource.map_or(String::new(), name);
                        let (rect, response) = ui.allocate_exact_size(
                            egui::vec2(width, 64.0),
                            egui::Sense::click_and_drag(),
                        );
                        let chosen = self.editor.backpack.selected(category) == slot;
                        ui.painter().rect_filled(
                            rect,
                            0.0,
                            if chosen {
                                Color32::from_rgb(42, 75, 34)
                            } else {
                                Color32::from_rgb(26, 26, 26)
                            },
                        );
                        ui.painter().rect_stroke(
                            rect,
                            0.0,
                            Stroke::new(
                                1.0_f32,
                                if chosen {
                                    GREEN
                                } else {
                                    Color32::from_white_alpha(30)
                                },
                            ),
                            egui::StrokeKind::Inside,
                        );
                        if let Some(resource) = resource {
                            thumbnail(ui.painter(), rect.shrink2(egui::vec2(8.0, 12.0)), resource);
                        }
                        ui.painter().text(
                            rect.left_top() + egui::vec2(4.0, 4.0),
                            egui::Align2::LEFT_TOP,
                            (slot + 1).to_string(),
                            egui::FontId::proportional(10.0),
                            Color32::GRAY,
                        );
                        ui.painter().text(
                            rect.center_bottom() - egui::vec2(0.0, 4.0),
                            egui::Align2::CENTER_BOTTOM,
                            abbreviate(&label, 8),
                            egui::FontId::proportional(11.0),
                            Color32::WHITE,
                        );
                        if response.clicked() {
                            selected = Some(slot);
                        }
                        if response.double_clicked() {
                            selected = Some(slot);
                            self.interface.modal = Modal::None;
                            self.capture_request = Some(true);
                        }
                        if response.drag_started() {
                            self.interface.inventory_drag = Some((category, slot));
                        }
                        if response.contains_pointer()
                            && ui.input(|i| i.pointer.any_released())
                            && let Some((from_category, from)) =
                                self.interface.inventory_drag.take()
                            && from_category == category
                        {
                            swap = Some((from, slot));
                        }
                        response.context_menu(|ui| {
                            if ui.button("Rename").clicked() {
                                self.interface.inventory_name = label.clone();
                                selected = Some(slot);
                                ui.close();
                            }
                            if ui.button("Duplicate").clicked() {
                                duplicate = Some(slot);
                                ui.close();
                            }
                            if ui.button("Delete").clicked() {
                                remove = Some(slot);
                                ui.close();
                            }
                        });
                        if slot % 9 == 8 {
                            ui.end_row();
                        }
                    }
                });
        };
        frame().fill(Color32::from_rgb(28, 44, 20)).show(ui, |ui| {
            ui.label(RichText::new("HOTBAR · Shift+1–9").color(GREEN));
            draw_slots(ui, 0..9);
        });
        ui.label(format!(
            "Backpack storage · Slots 10–{}",
            category.capacity()
        ));
        egui::ScrollArea::vertical()
            .id_salt("backpack-storage")
            .max_height(360.0)
            .show(ui, |ui| draw_slots(ui, 9..category.capacity()));
        if ui.input(|i| i.pointer.any_released()) {
            self.interface.inventory_drag = None;
        }
        if let Some(slot) = selected {
            self.equip(category, slot);
        }
        if let Some(slot) = remove {
            let r = self
                .editor
                .backpack
                .replace(category, slot, None)
                .map(|_| ());
            self.result(r);
            self.editor.revision += 1;
        }
        if let Some(slot) = duplicate
            && let Some(resource) = self.editor.backpack.get(category, slot).cloned()
        {
            let r = self.editor.backpack.insert(resource).map(|_| ());
            self.result(r);
            self.editor.revision += 1;
        }
        if let Some((a, b)) = swap {
            let r = self.editor.backpack.swap(category, a, b);
            self.result(r);
            self.editor.revision += 1;
        }
        ui.horizontal(|ui| {
            ui.add(
                egui::TextEdit::singleline(&mut self.interface.inventory_name)
                    .hint_text("Item name")
                    .char_limit(80),
            );
            if ui.button("Rename selected").clicked() {
                let slot = self.editor.backpack.selected(category);
                let r = self
                    .editor
                    .backpack
                    .rename(category, slot, &self.interface.inventory_name);
                self.result(r);
                self.editor.revision += 1;
            }
        });
    }

    fn entity_modal(&mut self, ui: &mut egui::Ui) {
        let Some(index) = self
            .editor
            .selected_entity
            .filter(|i| *i < self.editor.entities.len())
        else {
            ui.label("Aim at an entity and press C, or choose an entity below.");
            for i in 0..self.editor.entities.len() {
                if ui.button(self.editor.entities[i].name()).clicked() {
                    self.editor.selected_entity = Some(i);
                }
            }
            return;
        };
        let mut entity = self.editor.entities[index].clone();
        let original = entity.clone();
        let Some(root) = entity.definition.root.as_ref() else {
            return;
        };
        let mut selected = self
            .interface
            .component
            .clone()
            .filter(|id| tree::find(root, id).is_some())
            .unwrap_or_else(|| root.id.clone());
        let mut apply_scripts = false;
        let mut detach = false;
        let mut pivot_change = None;
        ui.horizontal_wrapped(|ui| {
            ui.heading(entity.name());
            if ui
                .button(if entity.running { "Stop" } else { "Run" })
                .clicked()
            {
                entity.running = !entity.running;
                apply_scripts = true;
            }
            apply_scripts |= ui.button("Save scripts · Cmd+Enter").clicked();
            if ui.button("API docs").clicked() {
                self.interface.modal = Modal::ApiDocs;
            }
            if entity.running {
                ui.small("Stop to edit geometry and constraints");
            }
        });
        ui.separator();
        let width = ui.available_width();
        let left = (width * 0.19).clamp(140.0, 210.0);
        let right = (width * 0.30).clamp(220.0, 300.0);
        let middle = (width - left - right - 24.0).max(180.0);
        ui.horizontal_top(|ui| {
            ui.allocate_ui_with_layout(egui::vec2(left, 500.0),egui::Layout::top_down(egui::Align::Min),|ui| {
                ui.set_width(left); self.entity_preview.show(ui,&entity,self.editor.revision,&mut selected); ui.heading("Components");
                egui::ScrollArea::vertical().id_salt("component-tree").max_height(360.0).show(ui, |ui| component_tree(ui,entity.definition.root.as_ref().unwrap(),&mut selected));
                ui.add_enabled_ui(!entity.running, |ui| {
                    if ui.button("Add child").clicked() {
                        let root = entity.definition.root.as_mut().unwrap(); let id = tree::unique_id(root,"component");
                        if let Some(parent) = tree::find_mut(root,&selected) { parent.children.push(pb::Component { id:id.clone(), name:"Component".into(), body:Some(tree::stopped_body()), script_language:"assemblyscript".into(), ..Default::default() }); selected=id; }
                    }
                    detach = ui.button("Detach subtree").clicked();
                    if ui.button("Delete subtree").clicked() { let r=tree::remove(&mut entity.definition,&selected).map(|_|()); self.result(r); }
                });
            });
            ui.separator();
            ui.allocate_ui_with_layout(egui::vec2(middle,500.0),egui::Layout::top_down(egui::Align::Min),|ui| {
                ui.set_width(middle);
                ui.horizontal(|ui| { ui.selectable_value(&mut self.interface.tab,EditorTab::Script,"Script"); ui.selectable_value(&mut self.interface.tab,EditorTab::Constraints,"Constraints"); });
                if self.interface.tab == EditorTab::Constraints { ui.add_enabled_ui(!entity.running, |ui| constraints_ui(ui,&mut entity.definition)); }
                else if let Some(node) = tree::find_mut(entity.definition.root.as_mut().unwrap(),&selected) {
                    let draft=self.interface.script_drafts.entry((entity.id.clone(),node.id.clone())).or_insert_with(||node.script.clone().unwrap_or_default());
                    ui.horizontal(|ui| { ui.label("AssemblyScript"); ui.checkbox(&mut node.script_disabled,"Disabled"); });
                    egui::ScrollArea::both().id_salt("script-scroll").max_height(380.0).show(ui, |ui| { ui.add(egui::TextEdit::multiline(draft).code_editor().desired_width(middle).desired_rows(22).lock_focus(true)); });
                }
                ui.separator(); ui.strong("Console");
                egui::ScrollArea::vertical().id_salt("script-console").max_height(125.0).stick_to_bottom(true).show(ui,|ui| {
                    if let Some(state)=self.runtime_frame.as_ref().and_then(|f|f.entities.iter().find(|e| e.id==entity.id)) {
                        ui.small(&state.status); if let Some(error)=&state.error { ui.colored_label(Color32::LIGHT_RED,error); } for line in &state.logs { ui.monospace(line); }
                    } else { ui.small("Run the entity to start the script console."); }
                });
            });
            ui.separator();
            ui.allocate_ui_with_layout(egui::vec2(right,500.0),egui::Layout::top_down(egui::Align::Min),|ui| {
                ui.set_width(right); ui.heading("Properties");
                egui::ScrollArea::vertical().id_salt("entity-inspector").max_height(540.0).show(ui, |ui| ui.add_enabled_ui(!entity.running, |ui| {
                    let root_id = entity.definition.root.as_ref().unwrap().id.clone();
                    let fallback = tree::center(entity.definition.root.as_ref().unwrap());
                    if selected == root_id {
                        let mut p=DVec3::from_array(entity.position); if vector(ui,"World position",&mut p,0.125) { entity.position=p.to_array(); }
                        ui.horizontal(|ui| { for axis in 0..3 { if ui.small_button(format!("{} +90°",["X","Y","Z"][axis])).clicked() { entity.rotation=(space_native::resource_transform::quarter(axis,1)*glam::DQuat::from_array(entity.rotation)).to_array(); } } });
                    }
                    if let Some(node)=tree::find_mut(entity.definition.root.as_mut().unwrap(),&selected) {
                        ui.label("Display name"); ui.add(egui::TextEdit::singleline(&mut node.name).char_limit(80));
                        ui.small(format!("ID: {}\n{} blocks · {} decorations",node.id,node.blocks.len(),node.decorations.len()));
                        body_properties(ui,node);
                        if selected != root_id {
                            let mut p=tree::vector(node.local_position.as_ref()); if vector(ui,"Local position",&mut p,0.125) { node.local_position=Some(tree::pb_vector(p)); }
                            ui.horizontal(|ui| { for axis in 0..3 { if ui.small_button(format!("{} +90°",["X","Y","Z"][axis])).clicked() { node.local_rotation=Some(tree::pb_quaternion(space_native::resource_transform::quarter(axis,1)*tree::quaternion(node.local_rotation.as_ref()))); } } });
                        }
                        let mut pivot=node.pivot.as_ref().map_or(fallback, |p| tree::vector(Some(p)));
                        if vector(ui,"Pivot",&mut pivot,0.125) { pivot_change=Some((selected.clone(),pivot)); }
                        ui.collapsing("Seats",|ui|seats_ui(ui,node));
                        ui.collapsing("Decorations",|ui|decorations_ui(ui,node,&mut self.interface.decoration));
                    }
                    ui.separator();
                    ui.add(egui::TextEdit::singleline(&mut self.interface.component_id).hint_text("New component ID"));
                    if ui.button("Rename ID").clicked() {
                        let r=tree::rename(&mut entity.definition,&selected,&self.interface.component_id);
                        if r.is_ok() { let old=(entity.id.clone(),selected.clone()); selected=self.interface.component_id.trim().to_owned(); if let Some(draft)=self.interface.script_drafts.remove(&old) { self.interface.script_drafts.insert((entity.id.clone(),selected.clone()),draft); } } self.result(r);
                    }
                    ui.add(egui::TextEdit::singleline(&mut self.interface.reparent_target).hint_text("New parent ID"));
                    if ui.button("Move subtree").clicked() { let r=tree::reparent(&mut entity.definition,&selected,&self.interface.reparent_target); self.result(r); }
                }));
            });
        });
        if let Some((id, pivot)) = pivot_change {
            let r = tree::set_pivot(&mut entity, &id, pivot);
            self.result(r);
        }
        self.interface.component = Some(selected.clone());
        if entity != original {
            self.editor.ensure_stroke();
            let r = self.editor.update_entity(index, |e| {
                *e = entity;
                Ok(())
            });
            self.result(r);
        }
        if !ui.input(|i| i.pointer.any_down()) && !ui.ctx().wants_keyboard_input() {
            self.editor.end_stroke();
        }
        if apply_scripts {
            let r = self.apply_scripts();
            self.result(r);
        }
        if detach {
            let r = self
                .apply_scripts()
                .and_then(|()| self.editor.detach_component(index, &selected));
            self.result(r);
        }
    }
    fn preferences_ui(&mut self, ui: &mut egui::Ui, renderer: &Renderer) {
        ui.heading("Camera");
        ui.add(
            egui::Slider::new(&mut self.interface.preferences.fov, 30.0..=120.0)
                .text("Field of view"),
        );
        ui.add(
            egui::Slider::new(&mut self.interface.preferences.camera_distance, 1.5..=12.0)
                .text("Third-person distance"),
        );
        ui.horizontal(|ui| {
            for (index, label) in ["First person", "Third person", "Front view"]
                .iter()
                .enumerate()
            {
                ui.selectable_value(&mut self.perspective, index as u8, *label);
            }
        });
        ui.checkbox(&mut self.interface.preferences.minimap, "Minimap");
        ui.heading("Audio");
        ui.checkbox(&mut self.interface.preferences.music, "Background music");
        ui.checkbox(
            &mut self.interface.preferences.effects,
            "Tool sound effects",
        );
        ui.separator();
        self.settings_ui(ui, renderer);
        ui.separator();
        ui.label("Skin PNG (64×64)");
        ui.text_edit_singleline(&mut self.path);
        if ui.button("Load skin…").clicked()
            && let Some(path) = file_dialog::open()
        {
            self.path = path.to_string_lossy().into_owned();
            let r = self.load_skin();
            self.result(r);
        }
        if ui
            .checkbox(&mut self.interface.preferences.slim_skin, "Slim arms")
            .changed()
        {
            let bytes = self
                .interface
                .preferences
                .skin_path
                .as_ref()
                .and_then(|p| std::fs::read(p).ok())
                .unwrap_or_else(|| include_bytes!("../assets/default-skin.png").to_vec());
            match Avatar::from_png_style(&bytes, self.interface.preferences.slim_skin) {
                Ok(avatar) => {
                    self.avatar = avatar;
                    self.avatar_mode = None;
                }
                Err(e) => self.status = e.to_string(),
            }
        }
        if ui.button("Default skin").clicked() {
            match Avatar::bundled() {
                Ok(avatar) => {
                    self.avatar = avatar;
                    self.avatar_mode = None;
                    self.interface.preferences.skin_path = None;
                    self.interface.preferences.slim_skin = false;
                }
                Err(e) => self.status = e.to_string(),
            }
        }
        if ui.button("Save preferences").clicked() {
            let r = self.save();
            self.result(r);
        }
    }
}
fn component_tree(ui: &mut egui::Ui, node: &pb::Component, selected: &mut String) {
    egui::CollapsingHeader::new(if node.name.is_empty() {
        &node.id
    } else {
        &node.name
    })
    .id_salt(&node.id)
    .default_open(true)
    .show(ui, |ui| {
        if ui
            .selectable_label(
                *selected == node.id,
                format!("{} · {} blocks", node.id, node.blocks.len()),
            )
            .clicked()
        {
            *selected = node.id.clone();
        }
        for child in &node.children {
            component_tree(ui, child, selected);
        }
    });
}
fn body_properties(ui: &mut egui::Ui, node: &mut pb::Component) {
    let body = node.body.get_or_insert_with(tree::stopped_body);
    let mut kind = body.r#type;
    ui.horizontal(|ui| {
        ui.selectable_value(&mut kind, 0, "Dynamic");
        ui.selectable_value(&mut kind, 1, "Kinematic");
    });
    space_native::editor::set_body_type(body, kind);
    let mut gravity = body.use_gravity.unwrap_or(kind == 0);
    if ui.checkbox(&mut gravity, "Gravity").changed() {
        body.use_gravity = Some(gravity);
    }
    let mut collision = body.collision_enabled.unwrap_or(true);
    if ui.checkbox(&mut collision, "Collision").changed() {
        body.collision_enabled = Some(collision);
    }
    let mut auto = body.mass.is_none();
    if ui.checkbox(&mut auto, "Automatic mass").changed() {
        body.mass = if auto { None } else { Some(1.0) };
    }
    if let Some(mass) = &mut body.mass {
        ui.add(
            egui::DragValue::new(mass)
                .range(0.1..=1_000_000.0)
                .prefix("Mass "),
        );
    }
    for (label, value, default) in [
        ("Friction", &mut body.friction, 0.7),
        ("Restitution", &mut body.restitution, 0.0),
    ] {
        let mut v = value.unwrap_or(default);
        if ui
            .add(egui::Slider::new(&mut v, 0.0..=1.0).text(label))
            .changed()
        {
            *value = Some(v);
        }
    }
}
fn seats_ui(ui: &mut egui::Ui, node: &mut pb::Component) {
    ui.collapsing("Seats", |ui| {
        let mut remove = None;
        for (i, seat) in node.seats.iter_mut().enumerate() {
            ui.push_id(i, |ui| {
                let mut p = tree::vector(seat.position.as_ref());
                if vector(ui, &format!("Seat {}", i + 1), &mut p, 0.125) {
                    seat.position = Some(tree::pb_vector(p));
                }
                rotation_ui(ui, &mut seat.rotation);
                let mut fixed = seat.fixed_orientation.unwrap_or(false);
                if ui.checkbox(&mut fixed, "Fixed rider orientation").changed() {
                    seat.fixed_orientation = Some(fixed);
                }
                if ui.small_button("Remove seat").clicked() {
                    remove = Some(i);
                }
            });
        }
        if let Some(i) = remove {
            node.seats.remove(i);
        }
        if ui.button("Add seat").clicked() {
            node.seats.push(pb::Seat {
                position: Some(Default::default()),
                ..Default::default()
            });
        }
    });
}
fn rotation_ui(ui: &mut egui::Ui, q: &mut Option<pb::Quaternion>) {
    let (x, y, z) = tree::quaternion(q.as_ref()).to_euler(glam::EulerRot::XYZ);
    let mut degrees = DVec3::new(x, y, z) * 180.0 / std::f64::consts::PI;
    if vector(ui, "Rotation °", &mut degrees, 1.0) {
        let r = degrees * std::f64::consts::PI / 180.0;
        *q = Some(tree::pb_quaternion(glam::DQuat::from_euler(
            glam::EulerRot::XYZ,
            r.x,
            r.y,
            r.z,
        )));
    }
}
fn decorations_ui(ui: &mut egui::Ui, node: &mut pb::Component, selected: &mut Option<String>) {
    ui.collapsing("Decorations", |ui| {
        let mut remove = None;
        let mut duplicate = None;
        for (i, d) in node.decorations.iter_mut().enumerate() {
            ui.push_id(d.id.clone(), |ui| {
                if ui
                    .selectable_label(selected.as_ref() == Some(&d.id), &d.id)
                    .clicked()
                {
                    *selected = Some(d.id.clone());
                }
                if selected.as_ref() == Some(&d.id) {
                    let mut p = tree::vector(d.position.as_ref());
                    if vector(ui, "Position", &mut p, 0.01) {
                        d.position = Some(tree::pb_vector(p));
                    }
                    rotation_ui(ui, &mut d.rotation);
                    let mut scale = d
                        .scale
                        .as_ref()
                        .map_or(DVec3::ONE, |p| DVec3::new(p.x, p.y, p.z));
                    if vector(ui, "Size", &mut scale, 0.01) {
                        d.scale = Some(tree::pb_vector(
                            scale.clamp(DVec3::splat(0.001), DVec3::splat(256.0)),
                        ));
                    }
                    let mut rgb = [
                        (d.color_rgb >> 16) as u8,
                        (d.color_rgb >> 8) as u8,
                        d.color_rgb as u8,
                    ];
                    ui.color_edit_button_srgb(&mut rgb);
                    d.color_rgb = u32::from_be_bytes([0, rgb[0], rgb[1], rgb[2]]);
                    ui.add(egui::Slider::new(&mut d.material_id, 0..=101).text("Material"));
                    ui.horizontal(|ui| {
                        if ui.button("Duplicate").clicked() {
                            duplicate = Some(d.clone());
                        }
                        if ui.button("Delete").clicked() {
                            remove = Some(i);
                        }
                    });
                }
            });
        }
        if let Some(i) = remove {
            node.decorations.remove(i);
            *selected = None;
        }
        if let Some(mut d) = duplicate {
            d.id = uuid::Uuid::new_v4().to_string();
            *selected = Some(d.id.clone());
            node.decorations.push(d);
        }
    });
}
fn constraints_ui(ui: &mut egui::Ui, entity: &mut pb::Entity) {
    let Some(root) = entity.root.as_ref() else {
        return;
    };
    let mut ids = Vec::new();
    fn collect(c: &pb::Component, ids: &mut Vec<String>) {
        ids.push(c.id.clone());
        for child in &c.children {
            collect(child, ids);
        }
    }
    collect(root, &mut ids);
    let mut remove = None;
    for (i, c) in entity.constraints.iter_mut().enumerate() {
        ui.push_id(&c.id, |ui| {
            ui.collapsing(&c.id, |ui| {
                ui.horizontal(|ui| {
                    ui.selectable_value(&mut c.r#type, 0, "Point");
                    ui.selectable_value(&mut c.r#type, 1, "Hinge");
                    ui.selectable_value(&mut c.r#type, 2, "Weld");
                });
                egui::ComboBox::from_id_salt("body-a")
                    .selected_text(c.body_a_component_id.as_deref().unwrap_or("World"))
                    .show_ui(ui, |ui| {
                        ui.selectable_value(&mut c.body_a_component_id, None, "World");
                        for id in &ids {
                            ui.selectable_value(&mut c.body_a_component_id, Some(id.clone()), id);
                        }
                    });
                egui::ComboBox::from_id_salt("body-b")
                    .selected_text(&c.body_b_component_id)
                    .show_ui(ui, |ui| {
                        for id in &ids {
                            ui.selectable_value(&mut c.body_b_component_id, id.clone(), id);
                        }
                    });
                for (label, value) in [
                    ("Anchor A", &mut c.anchor_a),
                    ("Anchor B", &mut c.anchor_b),
                    ("Axis A", &mut c.axis_a),
                    ("Axis B", &mut c.axis_b),
                    ("Reference A", &mut c.reference_a),
                    ("Reference B", &mut c.reference_b),
                ] {
                    let mut p = tree::vector(value.as_ref());
                    if vector(ui, label, &mut p, 0.125) {
                        *value = Some(tree::pb_vector(p));
                    }
                }
                let mut limited = c.limits.is_some();
                if ui
                    .checkbox(&mut limited, "Hinge limits (radians)")
                    .changed()
                {
                    c.limits = limited.then_some(pb::ConstraintLimits {
                        min: -std::f64::consts::PI,
                        max: std::f64::consts::PI,
                    });
                }
                if let Some(l) = &mut c.limits {
                    ui.horizontal(|ui| {
                        ui.add(egui::DragValue::new(&mut l.min).speed(0.01).prefix("Min "));
                        ui.add(egui::DragValue::new(&mut l.max).speed(0.01).prefix("Max "));
                    });
                }
                ui.add(egui::Slider::new(&mut c.stiffness, 0.0..=1.0).text("Stiffness"));
                ui.checkbox(&mut c.collide_connected, "Collide connected bodies");
                if ui.button("Delete constraint").clicked() {
                    remove = Some(i);
                }
            });
        });
    }
    if let Some(i) = remove {
        entity.constraints.remove(i);
    }
    if ui.button("Add constraint").clicked() {
        entity.constraints.push(pb::EntityConstraint {
            id: uuid::Uuid::new_v4().to_string(),
            body_b_component_id: ids[0].clone(),
            anchor_a: Some(Default::default()),
            anchor_b: Some(Default::default()),
            axis_a: Some(tree::pb_vector(DVec3::Y)),
            axis_b: Some(tree::pb_vector(DVec3::Y)),
            stiffness: 1.0,
            ..Default::default()
        });
    }
}
fn thumbnail(p: &egui::Painter, rect: egui::Rect, resource: &pb::InventoryResource) {
    if let Some(pb::inventory_resource::Content::ColorSet(set)) = &resource.content {
        for (i, entry) in set.entries.iter().take(9).enumerate() {
            let size = rect.width() / 3.0;
            let cell = egui::Rect::from_min_size(
                rect.min + egui::vec2((i % 3) as f32 * size, (i / 3) as f32 * size),
                egui::vec2(size - 1.0, size - 1.0),
            );
            p.rect_filled(cell, 0.0, color(palette::sample(entry, 0.5)));
        }
        return;
    }
    // Small, bounded CPU preview. Full geometry remains in the renderer's cached placement mesh.
    let blocks = match &resource.content {
        Some(pb::inventory_resource::Content::BlockSet(b)) => Some(&b.blocks),
        Some(pb::inventory_resource::Content::Entity(e)) => e.root.as_ref().map(|r| &r.blocks),
        Some(pb::inventory_resource::Content::Item(i)) => i
            .block_set
            .as_ref()
            .filter(|b| !b.blocks.is_empty())
            .map(|b| &b.blocks)
            .or_else(|| {
                i.entity_list
                    .first()
                    .and_then(|e| e.root.as_ref())
                    .map(|r| &r.blocks)
            }),
        _ => None,
    };
    if let Some(blocks) = blocks {
        let positions: Vec<_> = blocks
            .iter()
            .step_by(if rect.width() > 150.0 {
                1
            } else {
                (blocks.len() / 256).max(1)
            })
            .take(if rect.width() > 150.0 { 65536 } else { 256 })
            .map(|v| {
                let q = interaction::voxel(v);
                (
                    egui::vec2((q[0] - q[2]) as f32, ((q[0] + q[2]) * 0.5 - q[1]) as f32),
                    v.color_rgb,
                )
            })
            .collect();
        let mut min = egui::vec2(f32::INFINITY, f32::INFINITY);
        let mut max = -min;
        for (q, _) in &positions {
            min = min.min(*q);
            max = max.max(*q);
        }
        let scale =
            (rect.width() / (max.x - min.x + 2.0)).min(rect.height() / (max.y - min.y + 2.0));
        for (q, c) in positions {
            p.rect_filled(
                egui::Rect::from_center_size(
                    rect.center() + (q - (min + max) * 0.5) * scale,
                    egui::vec2(scale, scale),
                ),
                0.0,
                color(c),
            );
        }
    }
}
impl Game {
    fn text_ui(&mut self, ui: &mut egui::Ui) {
        ui.label("Create upright voxel text using the game's pixel font.");
        ui.add(
            egui::TextEdit::multiline(&mut self.interface.text)
                .desired_rows(4)
                .char_limit(256),
        );
        ui.add(egui::Slider::new(&mut self.interface.text_size, 8..=128).text("Font size (cells)"));
        ui.checkbox(&mut self.interface.import_micro, "Micro voxels");
        if ui.button("Preview text").clicked() {
            match space_native::text_voxels::create(
                &self.interface.text,
                self.interface.text_size,
                self.interface.import_micro,
                self.editor.rgb,
                self.editor.material,
            ) {
                Ok(r) => self.interface.text_preview = Some(r),
                Err(e) => self.status = e.to_string(),
            }
        }
        if let Some(resource) = self.interface.text_preview.clone() {
            let (rect, _) = ui.allocate_exact_size(egui::vec2(440.0, 180.0), egui::Sense::hover());
            thumbnail(ui.painter(), rect, &resource);
            if ui.button("Use in Hammer").clicked() {
                self.editor.clipboard = Some(resource);
                self.choose_tool(HotbarTool::Hammer);
                self.close_modal();
                self.capture_request = Some(true);
            }
        }
    }
    fn model_import_ui(&mut self, ui: &mut egui::Ui) {
        ui.label("Import a surface model as a block set.");
        if ui.button("Choose model…").clicked()
            && let Some(path) = file_dialog::open()
        {
            self.path = path.to_string_lossy().into_owned();
        }
        ui.text_edit_singleline(&mut self.path);
        ui.add(
            egui::Slider::new(&mut self.interface.import_resolution, 1..=256)
                .text("Longest side (metres)"),
        );
        ui.checkbox(&mut self.interface.import_micro, "Micro voxels");
        if self.import_job.is_some() {
            ui.label("Voxelizing model…");
            if ui.button("Cancel import").clicked() {
                self.import_job = None;
                self.status = "Import cancelled".into();
            }
        } else if ui.button("Voxelize and add to backpack").clicked() {
            let path = PathBuf::from(&self.path);
            let size = self.interface.import_resolution;
            let micro = self.interface.import_micro;
            let rgb = self.editor.rgb;
            let material = self.editor.material;
            let (send, receive) = crossbeam_channel::bounded(1);
            self.import_job = Some(receive);
            self.status = "Importing model…".into();
            std::thread::spawn(move || {
                let result = space_native::model_import::load(&path, size, micro, rgb, material);
                let _ = send.send(result);
            });
        }
    }
    fn tutorial_ui(&mut self, ui: &mut egui::Ui) {
        ui.label(
            "Practice in a separate tutorial world. Your current world is saved before entering.",
        );
        let chapters = [
            "Movement and flight",
            "Select and erase",
            "Copy and place",
            "Color and material",
            "Micro voxels",
            "Selection shapes",
            "Rotate selection",
            "Assemble and edit",
            "Wheel components",
            "Write a motor script",
            "Attach wheels",
            "Drive the car",
            "Modeling",
        ];
        for (i, title) in chapters.into_iter().enumerate() {
            if ui.button(format!("{:02}  {title}", i + 1)).clicked()
                && self.world.source.manifest.world == "tutorial"
            {
                self.interface.navigation_target =
                    Some(space_native::tutorial::lesson_position(i + 1));
                self.camera.flying = true;
                self.interface.modal = Modal::None;
            }
        }
        if ui
            .add_sized(
                [220.0, 42.0],
                egui::Button::new("Enter tutorial").fill(Color32::from_rgb(60, 133, 39)),
            )
            .clicked()
        {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let r = (|| {
                if !root.join("data/worlds/tutorial/manifest.json").exists() {
                    let output = space_native::node_command()
                        .arg(root.join("tools/terrain.ts"))
                        .arg("--world=tutorial")
                        .arg("--radius=0")
                        .output()?;
                    anyhow::ensure!(
                        output.status.success(),
                        "{}",
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                self.pending_world = Some("tutorial".into());
                self.interface.modal = Modal::None;
                Ok(())
            })();
            self.result(r);
        }
    }
    fn load_skin(&mut self) -> Result<()> {
        let bytes = std::fs::read(&self.path)?;
        anyhow::ensure!(bytes.len() <= 1024 * 1024, "Skin file exceeds 1 MiB");
        let avatar = Avatar::from_png_style(&bytes, self.interface.preferences.slim_skin)?;
        self.avatar = avatar;
        self.avatar_mode = None;
        self.interface.preferences.skin_path = Some(self.path.clone());
        Ok(())
    }
}
impl Game {
    pub(super) fn transform_gizmo(&mut self, ctx: &egui::Context, renderer: &Renderer) {
        use space_native::ui_state::TransformMode;
        if self.interface.modal != Modal::None {
            return;
        }
        let pinned = self.interface.placement.is_some();
        let index = self
            .editor
            .selected_entity
            .filter(|&i| i < self.editor.entities.len());
        let modeling = self.active_tool == HotbarTool::Model && self.interface.decoration.is_some();
        if !pinned && !modeling && self.active_tool != HotbarTool::Wrench {
            return;
        }
        let mut position = self.interface.placement.as_ref().map(|p| p.position);
        let mut local_to_world = glam::DMat4::IDENTITY;
        if !pinned && let Some(i) = index {
            let entity = &self.editor.entities[i];
            if entity.running {
                return;
            }
            if modeling {
                let Some(root) = entity.definition.root.as_ref() else {
                    return;
                };
                let Some(component) = self
                    .interface
                    .component
                    .as_deref()
                    .and_then(|id| tree::find(root, id))
                else {
                    return;
                };
                let Some(d) = component
                    .decorations
                    .iter()
                    .find(|d| Some(&d.id) == self.interface.decoration.as_ref())
                else {
                    return;
                };
                local_to_world = tree::pose(entity) * tree::matrix(root, &component.id).unwrap();
                position = Some(tree::vector(d.position.as_ref()));
            } else if self.interface.transform == TransformMode::Pivot {
                let root = entity.definition.root.as_ref().unwrap();
                let component = self
                    .interface
                    .component
                    .as_deref()
                    .and_then(|id| tree::find(root, id))
                    .unwrap_or(root);
                local_to_world = tree::pose(entity) * tree::matrix(root, &component.id).unwrap();
                position = Some(tree::pivot(root, component));
            } else {
                let root = entity.definition.root.as_ref().unwrap();
                position = Some(tree::pose(entity).transform_point3(tree::pivot(root, root)));
            }
        }
        let Some(position) = position else {
            return;
        };
        let rect = ctx.input(|i| i.viewport_rect());
        let size = renderer.frame_size();
        let clip = Mat4::from_cols_array_2d(&self.uniforms([size[0] as u32, size[1] as u32]).clip);
        let eye = self.view().0;
        let origin = local_to_world.transform_point3(position);
        let length = eye.distance(origin).mul_add(0.1, 0.0).clamp(0.5, 6.0);
        let Some(center) = interaction::project(origin, eye, clip, self.torus, rect) else {
            return;
        };
        let mode = if pinned {
            TransformMode::Translate
        } else {
            self.interface.transform
        };
        for (axis, (basis, tint)) in [
            (DVec3::X, Color32::from_rgb(242, 86, 86)),
            (DVec3::Y, GREEN),
            (DVec3::Z, Color32::from_rgb(86, 151, 242)),
        ]
        .into_iter()
        .enumerate()
        {
            let end = local_to_world.transform_point3(position + basis * length);
            let Some(end) = interaction::project(end, eye, clip, self.torus, rect) else {
                continue;
            };
            let vector = end - center;
            if vector.length() < 8.0 {
                continue;
            }
            let response = gizmo_axis(ctx, axis, center, end, tint);
            if response.drag_started() {
                self.gizmo_before = index.map(|i| self.editor.entities[i].clone());
                self.gizmo_origin = position;
                self.gizmo_pointer = ctx.input(|i| i.pointer.press_origin()).unwrap_or(center);
            }
            if response.dragged()
                && let Some(pointer) = response.interact_pointer_pos()
            {
                let amount =
                    (pointer - self.gizmo_pointer).dot(vector) / vector.length_sq() * length as f32;
                let snap = if modeling {
                    0.01
                } else if self.editor.micro {
                    0.125
                } else {
                    1.0
                };
                let mut next = self.gizmo_origin;
                next[axis] = ((next[axis] + amount as f64) / snap).round() * snap;
                if pinned {
                    self.interface.placement.as_mut().unwrap().position = next;
                } else if let Some(i) = index {
                    if modeling
                        && let Some(component) =
                            self.interface.component.as_deref().and_then(|id| {
                                tree::find_mut(
                                    self.editor.entities[i].definition.root.as_mut().unwrap(),
                                    id,
                                )
                            })
                        && let Some(d) = component
                            .decorations
                            .iter_mut()
                            .find(|d| Some(&d.id) == self.interface.decoration.as_ref())
                    {
                        match mode {
                            TransformMode::Rotate => {
                                let before = self
                                    .gizmo_before
                                    .as_ref()
                                    .and_then(|e| {
                                        tree::find(e.definition.root.as_ref()?, &component.id)
                                    })
                                    .and_then(|c| c.decorations.iter().find(|x| x.id == d.id))
                                    .map_or(glam::DQuat::IDENTITY, |d| {
                                        tree::quaternion(d.rotation.as_ref())
                                    });
                                d.rotation = Some(tree::pb_quaternion(
                                    glam::DQuat::from_axis_angle(
                                        basis,
                                        (amount as f64 / length) * std::f64::consts::PI,
                                    ) * before,
                                ));
                            }
                            TransformMode::Scale => {
                                let before = self
                                    .gizmo_before
                                    .as_ref()
                                    .and_then(|e| {
                                        tree::find(e.definition.root.as_ref()?, &component.id)
                                    })
                                    .and_then(|c| c.decorations.iter().find(|x| x.id == d.id))
                                    .and_then(|d| d.scale.as_ref())
                                    .map_or(DVec3::ONE, |s| tree::vector(Some(s)));
                                let mut size = before;
                                size[axis] = (size[axis] + amount as f64).clamp(0.001, 256.0);
                                d.scale = Some(tree::pb_vector(size));
                            }
                            _ => d.position = Some(tree::pb_vector(next)),
                        }
                    } else if let Some(before) = &self.gizmo_before {
                        match mode {
                            TransformMode::Rotate => {
                                let q = glam::DQuat::from_axis_angle(
                                    basis,
                                    (amount as f64 / length) * std::f64::consts::PI,
                                );
                                self.editor.entities[i].rotation =
                                    (q * glam::DQuat::from_array(before.rotation))
                                        .normalize()
                                        .to_array();
                                self.editor.entities[i].position = (self.gizmo_origin
                                    + q * (DVec3::from_array(before.position) - self.gizmo_origin))
                                    .to_array();
                            }
                            TransformMode::Pivot => {
                                let mut edited = before.clone();
                                let id = self.interface.component.clone().unwrap_or_else(|| {
                                    edited.definition.root.as_ref().unwrap().id.clone()
                                });
                                match tree::set_pivot(&mut edited, &id, next) {
                                    Ok(()) => self.editor.entities[i] = edited,
                                    Err(e) => self.status = e.to_string(),
                                }
                            }
                            _ => {
                                self.editor.entities[i].position =
                                    (DVec3::from_array(before.position) + next - self.gizmo_origin)
                                        .to_array()
                            }
                        }
                    }
                    self.editor.revision += 1;
                }
            }
            if response.drag_stopped()
                && let Some(before) = self.gizmo_before.take()
            {
                self.editor.record_transform(before);
            }
        }
    }
}
impl Game {
    fn minimap_ui(&mut self, ctx: &egui::Context) {
        if !self.interface.preferences.minimap {
            return;
        }
        if self.map_refresh.elapsed().as_secs_f32() > 0.5 {
            self.minimap.refresh(&self.world);
            self.map_refresh = Instant::now();
        }
        egui::Area::new("minimap".into())
            .anchor(egui::Align2::RIGHT_TOP, [-20.0, 66.0])
            .show(ctx, |ui| {
                frame().show(ui, |ui| {
                    let (rect, response) =
                        ui.allocate_exact_size(egui::vec2(152.0, 152.0), egui::Sense::click());
                    let center = rect.center();
                    let scale = 0.65;
                    let radius = rect.width() * 0.5 / scale;
                    ui.painter()
                        .rect_filled(rect, 0.0, Color32::from_rgb(20, 24, 30));
                    let painter = ui.painter().with_clip_rect(rect);
                    for (&(x, z), colors) in &self.minimap.tiles {
                        let wx =
                            geometry::wrap_near(x as f64 * 16.0, self.camera.position.x, 16384.0)
                                - self.camera.position.x;
                        let wz =
                            geometry::wrap_near(z as f64 * 16.0, self.camera.position.z, 2048.0)
                                - self.camera.position.z;
                        if wx.abs() > radius as f64 + 16.0 || wz.abs() > radius as f64 + 16.0 {
                            continue;
                        }
                        for sz in 0..4 {
                            for sx in 0..4 {
                                let p = center
                                    + egui::vec2(
                                        wx as f32 + sx as f32 * 4.0,
                                        wz as f32 + sz as f32 * 4.0,
                                    ) * scale;
                                painter.rect_filled(
                                    egui::Rect::from_min_size(
                                        p,
                                        egui::vec2(4.0 * scale, 4.0 * scale),
                                    ),
                                    0.0,
                                    color(colors[sz * 4 + sx]),
                                );
                            }
                        }
                    }
                    let direction =
                        egui::vec2(self.camera.yaw.sin() as f32, -self.camera.yaw.cos() as f32);
                    painter.line_segment(
                        [center, center + direction * 12.0],
                        Stroke::new(2.0_f32, GREEN),
                    );
                    painter.circle_filled(center, 3.0, Color32::WHITE);
                    painter.text(
                        rect.left_top() + egui::vec2(4.0, 4.0),
                        egui::Align2::LEFT_TOP,
                        "N",
                        egui::FontId::proportional(12.0),
                        Color32::WHITE,
                    );
                    if response.clicked()
                        && let Some(point) = response.interact_pointer_pos()
                    {
                        let delta = (point - center) / scale;
                        self.interface.navigation_target = Some(
                            self.camera.position + DVec3::new(delta.x as f64, 0.0, delta.y as f64),
                        );
                        self.camera.flying = true;
                    }
                    ui.small("Click to navigate");
                });
            });
    }
}

#[cfg(test)]
mod gizmo_tests {
    use super::*;
    #[test]
    fn axis_accepts_a_fast_drag_outside_its_original_rectangle() {
        let ctx = egui::Context::default();
        let sample = |events: Vec<egui::Event>| {
            let mut response = None;
            let _ = ctx.run(
                egui::RawInput {
                    screen_rect: Some(egui::Rect::from_min_size(
                        egui::Pos2::ZERO,
                        egui::vec2(800.0, 600.0),
                    )),
                    events,
                    ..Default::default()
                },
                |ctx| {
                    response = Some(gizmo_axis(
                        ctx,
                        0,
                        egui::pos2(400.0, 300.0),
                        egui::pos2(480.0, 300.0),
                        GREEN,
                    ));
                },
            );
            response.unwrap()
        };
        sample(vec![]);
        sample(vec![]);
        let start = egui::pos2(475.0, 300.0);
        let end = egui::pos2(625.0, 300.0);
        sample(vec![
            egui::Event::PointerMoved(start),
            egui::Event::PointerButton {
                pos: start,
                button: egui::PointerButton::Primary,
                pressed: true,
                modifiers: Default::default(),
            },
        ]);
        let moved = sample(vec![egui::Event::PointerMoved(end)]);
        assert!(moved.dragged());
        assert_eq!(moved.interact_pointer_pos(), Some(end));
        assert_eq!(ctx.input(|i| i.pointer.press_origin()), Some(start));
        let released = sample(vec![egui::Event::PointerButton {
            pos: end,
            button: egui::PointerButton::Primary,
            pressed: false,
            modifiers: Default::default(),
        }]);
        assert!(released.drag_stopped());
    }
}
