//! Offline tool bindings and resource geometry, shared by previews and tests.
use crate::{geometry::Face, protocol::inventory as pb, runtime};
use glam::{DVec3, Mat4, Quat, Vec3};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HotbarTool {
    Select,
    Hammer,
    Wrench,
    Shovel,
    Spoon,
    Brush,
    Model,
}
impl HotbarTool {
    pub const ALL: [Self; 7] = [
        Self::Select,
        Self::Hammer,
        Self::Wrench,
        Self::Shovel,
        Self::Spoon,
        Self::Brush,
        Self::Model,
    ];
    pub fn name(self) -> &'static str {
        match self {
            Self::Select => "Select",
            Self::Hammer => "Hammer",
            Self::Wrench => "Wrench",
            Self::Shovel => "Shovel",
            Self::Spoon => "Spoon",
            Self::Brush => "Brush",
            Self::Model => "Model",
        }
    }
    pub fn hint(self) -> &'static str {
        match self {
            Self::Select => "LMB: corners   G: assemble   Ctrl/Cmd+C: copy   Delete: erase",
            Self::Hammer => "LMB: pin preview   Enter: place   Arrows: rotate   Tab: grid",
            Self::Wrench => {
                "Hold LMB: grab   R: rotate   Wheel: distance   RMB: inspect   Esc: cancel"
            }
            Self::Shovel => "Hold LMB: remove   Hold RMB: build   One stroke = one undo",
            Self::Spoon => "Hold LMB: carve   Hold RMB: build   0.125 m grid",
            Self::Brush => "Hold LMB: paint   RMB: two-corner entity region",
            Self::Model => "LMB: select decoration   RMB: add cube   Drag XYZ: transform",
        }
    }
}
pub fn snap(position: DVec3, micro: bool) -> DVec3 {
    let scale = if micro { 8.0 } else { 1.0 };
    (position * scale).floor() / scale
}
pub fn voxel(v: &pb::Voxel) -> [f64; 6] {
    [
        v.dx as f64
            + if v.is_micro {
                v.micro_x as f64 / 8.0
            } else {
                0.0
            },
        v.dy as f64
            + if v.is_micro {
                v.micro_y as f64 / 8.0
            } else {
                0.0
            },
        v.dz as f64
            + if v.is_micro {
                v.micro_z as f64 / 8.0
            } else {
                0.0
            },
        if v.is_micro { 0.125 } else { 1.0 },
        v.color_rgb as f64,
        v.material_id as f64,
    ]
}
pub fn component_matrix(c: &pb::Component) -> Mat4 {
    let p = c.local_position.as_ref().map_or(Vec3::ZERO, |p| {
        Vec3::new(p.x as f32, p.y as f32, p.z as f32)
    });
    let q = c.local_rotation.as_ref().map_or(Quat::IDENTITY, |q| {
        Quat::from_xyzw(q.x as f32, q.y as f32, q.z as f32, q.w as f32)
    });
    Mat4::from_rotation_translation(q, p)
}
pub fn resource_parts(r: &pb::InventoryResource) -> Vec<(Vec<Face>, Mat4)> {
    fn component(c: &pb::Component, root: &pb::Component, parts: &mut Vec<(Vec<Face>, Mat4)>) {
        let m = crate::entity_edit::matrix(root, &c.id).unwrap().as_mat4();
        parts.push((
            runtime::voxel_faces(&c.blocks.iter().map(voxel).collect::<Vec<_>>()),
            m,
        ));
        for d in &c.decorations {
            let p = d.position.as_ref().map_or(Vec3::ZERO, |p| {
                Vec3::new(p.x as f32, p.y as f32, p.z as f32)
            });
            let q = d.rotation.as_ref().map_or(Quat::IDENTITY, |q| {
                Quat::from_xyzw(q.x as f32, q.y as f32, q.z as f32, q.w as f32)
            });
            let scale = d
                .scale
                .as_ref()
                .map_or(Vec3::ONE, |p| Vec3::new(p.x as f32, p.y as f32, p.z as f32));
            parts.push((
                runtime::voxel_faces(&[[
                    -0.5,
                    -0.5,
                    -0.5,
                    1.0,
                    d.color_rgb as f64,
                    d.material_id as f64,
                ]]),
                m * Mat4::from_scale_rotation_translation(scale, q, p),
            ));
        }
        for child in &c.children {
            component(child, root, parts);
        }
    }
    let mut parts = Vec::new();
    use pb::inventory_resource::Content;
    match &r.content {
        Some(Content::BlockSet(b)) => parts.push((
            runtime::voxel_faces(&b.blocks.iter().map(voxel).collect::<Vec<_>>()),
            Mat4::IDENTITY,
        )),
        Some(Content::Entity(e)) => {
            if let Some(c) = &e.root {
                component(c, c, &mut parts);
            }
        }
        Some(Content::Item(item)) => {
            if let Some(b) = &item.block_set {
                parts.push((
                    runtime::voxel_faces(&b.blocks.iter().map(voxel).collect::<Vec<_>>()),
                    Mat4::IDENTITY,
                ));
            }
            for e in &item.entity_list {
                if let Some(c) = &e.root {
                    component(c, c, &mut parts);
                }
            }
        }
        _ => {}
    }
    parts
}
/// Projects bounds with the same near-field correction as the terrain shader.
pub fn project(
    point: DVec3,
    eye: DVec3,
    clip: Mat4,
    torus: bool,
    rect: egui::Rect,
) -> Option<egui::Pos2> {
    let p = if torus {
        crate::geometry::bend_for_view(point, eye)
    } else {
        point
    };
    let p = clip * p.as_vec3().extend(1.0);
    if p.w <= 0.01 || p.z < 0.0 {
        return None;
    }
    let ndc = p.truncate() / p.w;
    Some(egui::pos2(
        rect.center().x + ndc.x * rect.width() * 0.5,
        rect.center().y - ndc.y * rect.height() * 0.5,
    ))
}

#[derive(Clone, Debug)]
pub struct MeshPick {
    pub key: String,
    pub distance: f64,
    pub local_point: DVec3,
    pub local_normal: DVec3,
    pub model: Mat4,
}
#[derive(Clone, Debug)]
pub struct ScenePick {
    pub entity: String,
    pub component: String,
    pub decoration: Option<String>,
    pub hit: MeshPick,
}
fn key_part(id: &str) -> String {
    id.as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
pub fn entity_mesh_key(entity: &str, component: &str) -> String {
    format!("entity:{entity}:{}", key_part(component))
}
pub fn decoration_mesh_key(entity: &str, component: &str, decoration: &str) -> String {
    format!(
        "{}:decoration:{}",
        entity_mesh_key(entity, component),
        key_part(decoration)
    )
}

/// UI commands cannot leak into an entity script while typing or selecting tools.
pub fn reserved_script_key(key: &str) -> bool {
    matches!(
        key,
        "Escape"
            | "Backspace"
            | "Delete"
            | "KeyB"
            | "KeyC"
            | "KeyF"
            | "KeyG"
            | "KeyR"
            | "KeyV"
            | "KeyX"
            | "F3"
            | "F5"
    ) || key.starts_with("Digit")
}
