use super::*;
use egui::{Color32, Pos2, Stroke, Vec2};
const ACCENT: Color32 = Color32::from_rgb(91, 224, 192);
const INK: Color32 = Color32::from_rgb(15, 24, 32);
pub(super) fn style(ctx: &egui::Context) {
    let mut v = egui::Visuals::dark();
    v.panel_fill = INK;
    v.window_fill = Color32::from_rgb(21, 32, 42);
    v.selection.bg_fill = Color32::from_rgb(36, 91, 82);
    v.selection.stroke = Stroke::new(1.0_f32, ACCENT);
    v.widgets.inactive.bg_fill = Color32::from_rgb(29, 43, 54);
    v.widgets.hovered.bg_fill = Color32::from_rgb(43, 67, 78);
    v.widgets.active.bg_fill = Color32::from_rgb(33, 103, 91);
    ctx.set_visuals(v);
    ctx.style_mut(|s| {
        s.spacing.button_padding = egui::vec2(10.0, 7.0);
        s.spacing.item_spacing = egui::vec2(7.0, 8.0);
    });
}
fn icon(p: &egui::Painter, c: Pos2, tool: HotbarTool, color: Color32) {
    let s = Stroke::new(1.8_f32, color);
    let line = |a: [f32; 2], b: [f32; 2]| p.line_segment([c + Vec2::from(a), c + Vec2::from(b)], s);
    match tool {
        HotbarTool::Select => {
            p.rect_stroke(
                egui::Rect::from_center_size(c, egui::vec2(18.0, 18.0)),
                2.0,
                s,
                egui::StrokeKind::Inside,
            );
            for x in [-9.0, 9.0] {
                for y in [-9.0, 9.0] {
                    p.circle_filled(c + egui::vec2(x, y), 2.0, color);
                }
            }
        }
        HotbarTool::Hammer => {
            line([-5.0, 11.0], [4.0, -5.0]);
            line([-5.0, -9.0], [10.0, -1.0]);
            line([-4.0, -12.0], [-7.0, -6.0]);
            line([11.0, -4.0], [8.0, 2.0]);
        }
        HotbarTool::Wrench => {
            line([-8.0, 10.0], [4.0, -2.0]);
            line([4.0, -2.0], [10.0, -4.0]);
            line([10.0, -4.0], [12.0, -10.0]);
            line([4.0, -2.0], [-1.0, -7.0]);
            line([-1.0, -7.0], [1.0, -13.0]);
        }
        HotbarTool::Shovel => {
            line([-7.0, 10.0], [2.0, -5.0]);
            p.rect_stroke(
                egui::Rect::from_center_size(c + egui::vec2(4.0, -6.0), egui::vec2(9.0, 11.0)),
                3.0,
                s,
                egui::StrokeKind::Inside,
            );
        }
        HotbarTool::Spoon => {
            line([-5.0, 11.0], [2.0, -2.0]);
            p.circle_stroke(c + egui::vec2(4.0, -7.0), 5.0, s);
        }
        HotbarTool::Brush => {
            line([-7.0, 11.0], [4.0, -5.0]);
            line([0.0, -4.0], [7.0, 0.0]);
            line([0.0, -4.0], [3.0, -12.0]);
            line([7.0, 0.0], [11.0, -8.0]);
            line([3.0, -12.0], [11.0, -8.0]);
        }
        HotbarTool::Model => {
            for (a, b) in [
                ([-9.0, -5.0], [0.0, -11.0]),
                ([0.0, -11.0], [10.0, -5.0]),
                ([10.0, -5.0], [0.0, 1.0]),
                ([0.0, 1.0], [-9.0, -5.0]),
                ([-9.0, -5.0], [-9.0, 6.0]),
                ([-9.0, 6.0], [0.0, 12.0]),
                ([0.0, 12.0], [10.0, 6.0]),
                ([10.0, 6.0], [10.0, -5.0]),
                ([0.0, 1.0], [0.0, 12.0]),
            ] {
                line(a, b);
            }
        }
    }
}
impl Game {
    pub(super) fn ui(
        &mut self,
        ctx: &egui::Context,
        renderer: &Renderer,
        fps: f64,
        captured: bool,
    ) {
        egui::TopBottomPanel::top("navigation")
            .frame(egui::Frame::new().fill(INK).inner_margin(10.0))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        egui::RichText::new("SPACE")
                            .size(19.0)
                            .strong()
                            .color(ACCENT),
                    );
                    ui.small("SOLO");
                    ui.separator();
                    for (panel, label) in [
                        (Panel::Build, "Tools"),
                        (Panel::Inventory, "Backpack  B"),
                        (Panel::Entities, "Entities"),
                        (Panel::Settings, "Settings  O"),
                    ] {
                        if ui
                            .selectable_label(
                                self.panel == panel && self.panel_open && !captured,
                                label,
                            )
                            .clicked()
                        {
                            self.panel_open = self.panel != panel || !self.panel_open;
                            self.panel = panel;
                            self.capture_request = Some(false);
                        }
                    }
                    if ui
                        .button(if captured {
                            "Controls  Esc"
                        } else {
                            "Play  Enter"
                        })
                        .clicked()
                    {
                        self.capture_request = Some(!captured);
                    }
                    if ui.button("Save").clicked() {
                        let r = self.save();
                        self.result(r);
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.small(format!("{fps:.0} fps"));
                    });
                });
            });
        egui::TopBottomPanel::bottom("status")
            .frame(egui::Frame::new().fill(INK).inner_margin(6.0))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.small(if self.editor.revision != self.saved_revision {
                        "LOCAL · unsaved changes"
                    } else {
                        "LOCAL · saved"
                    });
                    ui.separator();
                    ui.small(&self.status);
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.small(self.world.source.manifest.world.replace('-', " "));
                    });
                });
            });
        if !captured && self.panel_open {
            egui::SidePanel::left("inspector")
                .default_width(270.0)
                .max_width(360.0)
                .show(ctx, |ui| {
                    egui::ScrollArea::vertical().show(ui, |ui| match self.panel {
                        Panel::Build => self.build_ui(ui),
                        Panel::Inventory => self.inventory_ui(ui),
                        Panel::Entities => self.entities_ui(ui),
                        Panel::Settings => self.settings_ui(ui, renderer),
                    });
                });
        }
        egui::Area::new(egui::Id::new("perspective"))
            .anchor(egui::Align2::RIGHT_TOP, [-16.0, 66.0])
            .show(ctx, |ui| {
                egui::Frame::new()
                    .fill(INK.gamma_multiply(0.92))
                    .corner_radius(9.0)
                    .inner_margin(9.0)
                    .show(ui, |ui| {
                        ui.set_min_width(122.0);
                        ui.set_max_width(122.0);
                        ui.label(egui::RichText::new("WANDERER").small().color(ACCENT));
                        if ui
                            .button(match self.perspective {
                                0 => "F5 · First person",
                                1 => "F5 · Third person",
                                _ => "F5 · Front view",
                            })
                            .clicked()
                        {
                            self.perspective = (self.perspective + 1) % 3;
                        }
                        ui.small(if self.driver.is_some() {
                            "Riding · V to leave"
                        } else if self.camera.flying {
                            "Flying · F to walk"
                        } else {
                            "Walking · F to fly"
                        });
                    });
            });
        egui::Area::new(egui::Id::new("toolbelt"))
            .anchor(egui::Align2::CENTER_BOTTOM, [0.0, -36.0])
            .movable(false)
            .show(ctx, |ui| {
                egui::Frame::new()
                    .fill(INK.gamma_multiply(0.96))
                    .corner_radius(12.0)
                    .inner_margin(10.0)
                    .show(ui, |ui| {
                        ui.vertical_centered(|ui| {
                            ui.label(
                                egui::RichText::new(self.active_tool.hint())
                                    .size(11.0)
                                    .color(Color32::from_rgb(181, 203, 211)),
                            );
                        });
                        ui.horizontal(|ui| {
                            for (i, tool) in HotbarTool::ALL.into_iter().enumerate() {
                                let (rect, response) = ui.allocate_exact_size(
                                    egui::vec2(66.0, 65.0),
                                    egui::Sense::click(),
                                );
                                let active = self.active_tool == tool;
                                let p = ui.painter();
                                p.rect_filled(
                                    rect,
                                    7.0,
                                    if active {
                                        Color32::from_rgb(32, 76, 72)
                                    } else if response.hovered() {
                                        Color32::from_rgb(40, 57, 68)
                                    } else {
                                        Color32::from_rgb(25, 38, 49)
                                    },
                                );
                                if active {
                                    p.rect_stroke(
                                        rect,
                                        7.0,
                                        Stroke::new(1.5_f32, ACCENT),
                                        egui::StrokeKind::Inside,
                                    );
                                }
                                let color = if active {
                                    ACCENT
                                } else {
                                    Color32::from_rgb(203, 215, 224)
                                };
                                p.text(
                                    rect.left_top() + egui::vec2(6.0, 4.0),
                                    egui::Align2::LEFT_TOP,
                                    (i + 1).to_string(),
                                    egui::FontId::proportional(10.0),
                                    color,
                                );
                                icon(p, rect.center() - egui::vec2(0.0, 6.0), tool, color);
                                p.text(
                                    rect.center_bottom() - egui::vec2(0.0, 7.0),
                                    egui::Align2::CENTER_BOTTOM,
                                    tool.name(),
                                    egui::FontId::proportional(11.0),
                                    color,
                                );
                                if response.clicked() {
                                    self.choose_tool(tool);
                                }
                                response.on_hover_text(tool.hint());
                            }
                        });
                        ui.horizontal(|ui| {
                            if ui
                                .small_button(if self.editor.micro {
                                    "TAB · 0.125 m"
                                } else {
                                    "TAB · 1 m"
                                })
                                .clicked()
                            {
                                self.editor.micro = !self.editor.micro;
                            }
                            ui.small(format!(
                                "Brush {} · Material {}",
                                self.editor.brush, self.editor.material
                            ));
                            let color = Color32::from_rgb(
                                (self.editor.rgb >> 16) as u8,
                                (self.editor.rgb >> 8) as u8,
                                self.editor.rgb as u8,
                            );
                            ui.colored_label(color, "■");
                            ui.small("Ctrl/Cmd+Z Undo · R Rotate · B Backpack");
                        });
                    });
            });
        let rect = ctx.input(|i| i.viewport_rect());
        let center = rect.center();
        let p = ctx.layer_painter(egui::LayerId::new(
            egui::Order::Background,
            egui::Id::new("aim"),
        ));
        let hit = self.hit();
        let color = if hit.is_some() {
            ACCENT
        } else {
            Color32::from_white_alpha(180)
        };
        p.circle_stroke(center, 3.0, Stroke::new(1.0_f32, color));
        for dir in [egui::vec2(1.0, 0.0), egui::vec2(0.0, 1.0)] {
            p.line_segment(
                [center - dir * 7.0, center + dir * 7.0],
                Stroke::new(1.0_f32, color),
            );
        }
        let (eye, _) = self.view();
        let size = renderer.frame_size();
        let clip = Mat4::from_cols_array_2d(&self.uniforms([size[0] as u32, size[1] as u32]).clip);
        let draw_box = |min: DVec3, max: DVec3, color| {
            let points: Vec<_> = (0..8)
                .map(|i| {
                    interaction::project(
                        DVec3::new(
                            if i & 1 == 0 { min.x } else { max.x },
                            if i & 2 == 0 { min.y } else { max.y },
                            if i & 4 == 0 { min.z } else { max.z },
                        ),
                        eye,
                        clip,
                        self.torus,
                        rect,
                    )
                })
                .collect();
            for i in 0..8 {
                for bit in [1, 2, 4] {
                    if i & bit == 0
                        && let (Some(a), Some(b)) = (points[i], points[i | bit])
                    {
                        p.line_segment([a, b], Stroke::new(1.5_f32, color));
                    }
                }
            }
        };
        if let Some((a, b)) = self.editor.selection {
            let a = a.position();
            let mut b = if self.selecting {
                hit.map_or(b.position(), |h| h.cell.position())
            } else {
                b.position()
            };
            b.x = geometry::wrap_near(b.x, a.x, 16384.0);
            b.z = geometry::wrap_near(b.z, a.z, 2048.0);
            draw_box(
                a.min(b),
                a.max(b) + DVec3::splat(self.editor.selection.unwrap().0.scale()),
                ACCENT,
            );
        } else if let Some(hit) = hit
            && matches!(
                self.active_tool,
                HotbarTool::Shovel | HotbarTool::Spoon | HotbarTool::Brush | HotbarTool::Select
            )
        {
            let min = hit.cell.position();
            draw_box(
                min,
                min + DVec3::splat(hit.cell.scale()),
                Color32::from_rgb(245, 193, 102),
            );
        }
    }
}
