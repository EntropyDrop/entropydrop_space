use super::*;
use egui::{Color32, Pos2, Stroke, Vec2};
const ACCENT: Color32 = Color32::from_rgb(92, 255, 92);
const INK: Color32 = Color32::from_rgb(18, 18, 20);
pub(super) fn style(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    fonts.font_data.insert(
        "fusion-pixel".into(),
        egui::FontData::from_static(include_bytes!("../assets/fonts/fusion-pixel.ttf")).into(),
    );
    for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
        fonts
            .families
            .entry(family)
            .or_default()
            .insert(0, "fusion-pixel".into());
    }
    ctx.set_fonts(fonts);
    let mut v = egui::Visuals::dark();
    v.panel_fill = INK;
    v.window_fill = INK;
    v.window_corner_radius = egui::CornerRadius::ZERO;
    v.selection.bg_fill = Color32::from_rgb(60, 133, 39);
    v.selection.stroke = Stroke::new(1.0_f32, ACCENT);
    for widget in [
        &mut v.widgets.inactive,
        &mut v.widgets.hovered,
        &mut v.widgets.active,
        &mut v.widgets.noninteractive,
        &mut v.widgets.open,
    ] {
        widget.corner_radius = egui::CornerRadius::ZERO;
        widget.bg_stroke = Stroke::new(1.0_f32, Color32::from_white_alpha(40));
    }
    v.widgets.inactive.bg_fill = Color32::from_rgb(26, 26, 26);
    v.widgets.hovered.bg_fill = Color32::from_rgb(48, 48, 48);
    v.widgets.active.bg_fill = Color32::from_rgb(60, 133, 39);
    ctx.set_visuals(v);
    ctx.style_mut(|s| {
        s.spacing.button_padding = egui::vec2(8.0, 7.0);
        s.spacing.item_spacing = egui::vec2(6.0, 6.0);
        s.text_styles
            .insert(egui::TextStyle::Body, egui::FontId::proportional(14.0));
        s.text_styles
            .insert(egui::TextStyle::Button, egui::FontId::proportional(14.0));
    });
}

pub(super) fn icon(p: &egui::Painter, c: Pos2, tool: HotbarTool, color: Color32) {
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
        self.desktop_ui(ctx, renderer, fps, captured);
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
        let draw_box = |min: DVec3, max: DVec3, model: glam::DMat4, color| {
            let points: Vec<_> = (0..8)
                .map(|i| {
                    interaction::project(
                        model.transform_point3(DVec3::new(
                            if i & 1 == 0 { min.x } else { max.x },
                            if i & 2 == 0 { min.y } else { max.y },
                            if i & 4 == 0 { min.z } else { max.z },
                        )),
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
                hit.map_or(b.position(), |h| {
                    interaction::snap(h.point - h.normal * 0.002, b.micro)
                })
            } else {
                b.position()
            };
            b.x = geometry::wrap_near(b.x, a.x, 16384.0);
            b.z = geometry::wrap_near(b.z, a.z, 2048.0);
            draw_box(
                a.min(b),
                a.max(b) + DVec3::splat(self.editor.selection.unwrap().0.scale()),
                glam::DMat4::IDENTITY,
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
                glam::DMat4::IDENTITY,
                Color32::from_rgb(245, 193, 102),
            );
        }
        use space_native::entity_edit as tree;
        let selection = self
            .interface
            .brush_corner
            .as_ref()
            .or(self.editor.component_selection.as_ref());
        if let Some(selection) = selection
            && let Some(e) = self
                .editor
                .entities
                .iter()
                .find(|e| e.id == selection.entity)
            && let Some(root) = e.definition.root.as_ref()
            && let Some(component) = tree::find(root, &selection.component)
        {
            let model = self
                .runtime_frame
                .as_ref()
                .and_then(|f| f.entities.iter().find(|state| state.id == e.id))
                .and_then(|state| state.nodes.iter().find(|n| n.id == selection.component))
                .map(|n| Mat4::from_cols_array(&n.model).as_dmat4())
                .unwrap_or_else(|| {
                    tree::pose(e) * tree::matrix(root, &selection.component).unwrap()
                });
            let step = if selection.micro { 0.125 } else { 1.0 };
            let mut b = selection.b;
            if (self.selecting || self.interface.brush_corner.is_some())
                && let Some(pick) = self.pick_scene(renderer)
                && pick.entity == selection.entity
                && pick.component == selection.component
            {
                b = ((pick.hit.local_point - pick.hit.local_normal * 0.002) / step)
                    .floor()
                    .as_ivec3();
            }
            let (min, max) = if selection.all {
                component.blocks.iter().map(interaction::voxel).fold(
                    (DVec3::splat(f64::INFINITY), DVec3::splat(f64::NEG_INFINITY)),
                    |(min, max), v| {
                        let p = DVec3::new(v[0], v[1], v[2]);
                        (min.min(p), max.max(p + DVec3::splat(v[3])))
                    },
                )
            } else {
                (
                    selection.a.min(b).as_dvec3() * step,
                    (selection.a.max(b).as_dvec3() + DVec3::ONE) * step,
                )
            };
            if min.is_finite() {
                draw_box(min, max, model, ACCENT);
            }
            for extra in selection.extra.iter().take(1024) {
                let min = extra.as_dvec3() * step;
                draw_box(min, min + DVec3::splat(step), model, ACCENT);
            }
        }
        if self.active_tool == HotbarTool::Model
            && let Some(i) = self.editor.selected_entity
            && let Some(e) = self.editor.entities.get(i)
            && let Some(root) = e.definition.root.as_ref()
            && let Some(c) = self
                .interface
                .component
                .as_deref()
                .and_then(|id| tree::find(root, id))
            && let Some(d) = c
                .decorations
                .iter()
                .find(|d| Some(&d.id) == self.interface.decoration.as_ref())
        {
            let scale = d
                .scale
                .as_ref()
                .map_or(DVec3::ONE, |s| tree::vector(Some(s)));
            let model = tree::pose(e)
                * tree::matrix(root, &c.id).unwrap()
                * glam::DMat4::from_scale_rotation_translation(
                    scale,
                    tree::quaternion(d.rotation.as_ref()),
                    tree::vector(d.position.as_ref()),
                );
            draw_box(
                DVec3::splat(-0.5),
                DVec3::splat(0.5),
                model,
                Color32::from_rgb(245, 193, 102),
            );
        }
        if self.world.source.manifest.world == "tutorial" {
            for e in &self.editor.entities {
                let position = DVec3::from_array(e.position);
                if (position - eye).length() <= 32.0
                    && let Some(at) =
                        interaction::project(position + DVec3::Y * 3.0, eye, clip, self.torus, rect)
                {
                    p.text(
                        at,
                        egui::Align2::CENTER_BOTTOM,
                        e.name(),
                        egui::FontId::proportional(14.0),
                        ACCENT,
                    );
                }
            }
        }
    }
}
