//! Cached native component preview. Picking and orbit controls share the drawn quads.
use egui::{Color32, Pos2, Rect, Stroke};
use glam::{Mat4, Quat, Vec3};
use space_native::{entity_edit as tree, geometry::Face, protocol::inventory as pb};
struct Quad {
    points: [Vec3; 4],
    normal: Vec3,
    rgb: u32,
    component: String,
}
#[derive(Default)]
pub struct Preview {
    key: Option<(String, u64)>,
    quads: Vec<Quad>,
    center: Vec3,
    radius: f32,
    yaw: f32,
    pitch: f32,
    zoom: f32,
}
impl Preview {
    pub fn show(
        &mut self,
        ui: &mut egui::Ui,
        entity: &space_native::editor::PlacedEntity,
        revision: u64,
        selected: &mut String,
    ) {
        if self.key.as_ref() != Some(&(entity.id.clone(), revision)) {
            let reset = self.key.as_ref().is_none_or(|k| k.0 != entity.id);
            self.key = Some((entity.id.clone(), revision));
            self.quads.clear();
            if reset {
                self.yaw = -0.6;
                self.pitch = 0.4;
                self.zoom = 1.0;
            }
            fn add(out: &mut Vec<Quad>, faces: Vec<Face>, model: Mat4, id: &str) {
                for f in faces {
                    let axis = f.axis as usize / 2;
                    let u = (axis + 1) % 3;
                    let v = (axis + 2) % 3;
                    let origin = Vec3::from_array(f.origin);
                    let points = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]].map(|uv| {
                        let mut p = origin;
                        p[u] += uv[0] * f.extent[0];
                        p[v] += uv[1] * f.extent[1];
                        model.transform_point3(p)
                    });
                    let mut normal = Vec3::ZERO;
                    normal[axis] = if f.axis % 2 == 0 { -1.0 } else { 1.0 };
                    out.push(Quad {
                        points,
                        normal: model.transform_vector3(normal).normalize_or_zero(),
                        rgb: f.color & 0xffffff,
                        component: id.into(),
                    });
                }
            }
            fn visit(out: &mut Vec<Quad>, node: &pb::Component, root: &pb::Component) {
                let model = tree::matrix(root, &node.id).unwrap().as_mat4();
                add(
                    out,
                    space_native::runtime::voxel_faces(
                        &node
                            .blocks
                            .iter()
                            .map(space_native::interaction::voxel)
                            .collect::<Vec<_>>(),
                    ),
                    model,
                    &node.id,
                );
                for d in &node.decorations {
                    let scale = d
                        .scale
                        .as_ref()
                        .map_or(Vec3::ONE, |s| tree::vector(Some(s)).as_vec3());
                    add(
                        out,
                        space_native::runtime::voxel_faces(&[[
                            -0.5,
                            -0.5,
                            -0.5,
                            1.0,
                            d.color_rgb as f64,
                            d.material_id as f64,
                        ]]),
                        model
                            * Mat4::from_scale_rotation_translation(
                                scale,
                                tree::quaternion(d.rotation.as_ref()).as_quat(),
                                tree::vector(d.position.as_ref()).as_vec3(),
                            ),
                        &node.id,
                    );
                }
                for child in &node.children {
                    visit(out, child, root);
                }
            }
            if let Some(root) = &entity.definition.root {
                visit(&mut self.quads, root, root);
            }
            let min = self
                .quads
                .iter()
                .flat_map(|q| q.points)
                .fold(Vec3::splat(f32::INFINITY), Vec3::min);
            let max = self
                .quads
                .iter()
                .flat_map(|q| q.points)
                .fold(Vec3::splat(f32::NEG_INFINITY), Vec3::max);
            self.center = if min.is_finite() {
                (min + max) * 0.5
            } else {
                Vec3::ZERO
            };
            self.radius = if min.is_finite() {
                (max - min).length().max(0.1) * 0.5
            } else {
                1.0
            };
        }
        let (rect, response) = ui.allocate_exact_size(
            egui::vec2(ui.available_width(), 170.0),
            egui::Sense::click_and_drag(),
        );
        ui.painter()
            .rect_filled(rect, 0.0, Color32::from_rgb(9, 13, 17));
        if response.dragged() {
            let delta = ui.input(|i| i.pointer.delta());
            self.yaw += delta.x * 0.012;
            self.pitch = (self.pitch + delta.y * 0.012).clamp(-1.5, 1.5);
        }
        if response.hovered() {
            let scroll = ui.input(|i| i.smooth_scroll_delta.y);
            self.zoom = (self.zoom * (scroll * 0.002).exp()).clamp(0.3, 4.0);
        }
        let rotation = Quat::from_rotation_x(self.pitch) * Quat::from_rotation_y(self.yaw);
        let scale = rect.width().min(rect.height()) * 0.42 / self.radius * self.zoom;
        let mut faces: Vec<_> = self
            .quads
            .iter()
            .filter_map(|q| {
                let n = rotation * q.normal;
                if n.z <= 0.001 {
                    return None;
                }
                let points = q.points.map(|p| rotation * (p - self.center));
                let depth = points.iter().map(|p| p.z).sum::<f32>();
                let points = points.map(|p| rect.center() + egui::vec2(p.x, -p.y) * scale);
                let light = 0.55 + 0.45 * n.dot(Vec3::new(-0.4, 0.7, 1.0).normalize()).max(0.0);
                let c = Color32::from_rgb(
                    ((q.rgb >> 16 & 255) as f32 * light) as u8,
                    ((q.rgb >> 8 & 255) as f32 * light) as u8,
                    ((q.rgb & 255) as f32 * light) as u8,
                );
                Some((depth, points, c, &q.component))
            })
            .collect();
        faces.sort_by(|a, b| a.0.total_cmp(&b.0));
        let painter = ui.painter().with_clip_rect(rect);
        let mut mesh = egui::Mesh::default();
        let mut picked = None;
        for (_, points, color, id) in faces {
            if response.clicked()
                && let Some(at) = response.interact_pointer_pos()
                && inside(points, at)
            {
                picked = Some(id.clone());
            }
            let first = mesh.vertices.len() as u32;
            for point in points {
                mesh.colored_vertex(point, color);
            }
            mesh.add_triangle(first, first + 1, first + 2);
            mesh.add_triangle(first, first + 2, first + 3);
            if id == selected {
                for i in 0..4 {
                    painter.line_segment(
                        [points[i], points[(i + 1) % 4]],
                        Stroke::new(0.5_f32, Color32::from_rgba_unmultiplied(92, 255, 92, 55)),
                    );
                }
            }
        }
        painter.add(egui::Shape::mesh(mesh));
        painter.rect_stroke(
            rect,
            0.0,
            Stroke::new(1.0_f32, Color32::from_gray(55)),
            egui::StrokeKind::Inside,
        );
        if let Some(id) = picked {
            *selected = id;
        }
        ui.small("Drag: orbit · scroll: zoom · click: component");
    }
}
fn inside(p: [Pos2; 4], at: Pos2) -> bool {
    if !Rect::from_points(&p).contains(at) {
        return false;
    }
    let crosses = (0..4)
        .map(|i| {
            let a = p[(i + 1) % 4] - p[i];
            let b = at - p[i];
            a.x * b.y - a.y * b.x
        })
        .collect::<Vec<_>>();
    crosses.iter().all(|v| *v >= -0.01) || crosses.iter().all(|v| *v <= 0.01)
}
