pub use crate::entropydrop::space::api::v2 as api;
pub use crate::entropydrop::space::backpack::v10 as backpack;
pub use crate::entropydrop::space::inventory::v8 as inventory;
use anyhow::{Result, ensure};
use prost::Message;
use std::collections::HashSet;
pub const MAX_RESOURCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_VOXELS: usize = 65_536;

pub fn decode(bytes: &[u8]) -> Result<inventory::InventoryResource> {
    ensure!(
        bytes.len() <= MAX_RESOURCE_BYTES,
        "Inventory resource exceeds 8 MiB"
    );
    let value = inventory::InventoryResource::decode(bytes)?;
    validate(&value)?;
    Ok(value)
}
pub fn validate(value: &inventory::InventoryResource) -> Result<()> {
    use inventory::inventory_resource::Content;
    ensure!(value.schema_version == 8, "Expected inventory schema v8");
    match value.content.as_ref() {
        Some(Content::BlockSet(b)) => validate_voxels(&b.blocks),
        Some(Content::Entity(e)) => validate_entity(e),
        Some(Content::Item(i)) => {
            let mut count = i.block_set.as_ref().map_or(0, |b| b.blocks.len());
            if let Some(b) = &i.block_set {
                validate_voxels(&b.blocks)?;
            }
            ensure!(i.entity_list.len() <= 1024, "Too many item entities");
            for e in &i.entity_list {
                validate_entity(e)?;
                count += entity_voxel_count(e);
            }
            ensure!(count > 0 && count <= MAX_VOXELS, "Invalid item voxel count");
            Ok(())
        }
        Some(Content::ColorSet(c)) => {
            ensure!(
                !c.entries.is_empty() && c.entries.len() <= 256,
                "Invalid palette size"
            );
            for e in &c.entries {
                ensure!(
                    e.material_id <= 101 && !e.stops.is_empty() && e.stops.len() <= 5,
                    "Invalid palette entry"
                );
                let mut previous = 0;
                for s in &e.stops {
                    ensure!(
                        s.color_rgb <= 0xffffff
                            && s.offset_millis <= 1000
                            && s.offset_millis >= previous,
                        "Invalid gradient"
                    );
                    previous = s.offset_millis;
                }
            }
            Ok(())
        }
        None => anyhow::bail!("Inventory resource has no content"),
    }
}
pub fn validate_voxels(v: &[inventory::Voxel]) -> Result<()> {
    ensure!(v.len() <= MAX_VOXELS, "Too many voxels");
    for b in v {
        ensure!(
            b.color_rgb <= 0xffffff && b.material_id <= 101,
            "Invalid voxel material"
        );
        ensure!(
            [b.dx, b.dy, b.dz]
                .iter()
                .all(|x| i64::from(*x).abs() <= 512),
            "Voxel coordinate out of range"
        );
        ensure!(
            !b.is_micro || (b.micro_x < 8 && b.micro_y < 8 && b.micro_z < 8),
            "Invalid micro offset"
        );
    }
    Ok(())
}
pub fn validate_entity(e: &inventory::Entity) -> Result<()> {
    let root = e
        .root
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Entity has no root"))?;
    let mut ids = HashSet::new();
    let mut count = 0;
    let mut script_bytes = 0;
    let mut seats = 0;
    let mut decorations = 0;
    let mut stack = vec![(root, 0)];
    while let Some((c, depth)) = stack.pop() {
        ensure!(
            depth <= 16 && ids.len() < 64,
            "Component hierarchy exceeds limits"
        );
        ensure!(
            !c.id.is_empty() && ids.insert(c.id.as_str()),
            "Component id is empty or duplicated"
        );
        validate_voxels(&c.blocks)?;
        count += c.blocks.len();
        ensure!(count <= MAX_VOXELS, "Too many entity voxels");
        ensure!(
            c.script.as_ref().is_none_or(|s| s.len() <= 65536),
            "Entity script exceeds 64 KiB"
        );
        script_bytes += c.script.as_ref().map_or(0, String::len);
        ensure!(script_bytes <= 512 * 1024, "Entity scripts exceed 512 KiB");
        for p in [&c.pivot, &c.local_position].into_iter().flatten() {
            validate_vector(p, 512.0)?;
        }
        for q in [&c.local_rotation, &c.anchor_rotation]
            .into_iter()
            .flatten()
        {
            validate_quaternion(q)?;
        }
        let body = c
            .body
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Component has no body config"))?;
        ensure!((0..=1).contains(&body.r#type), "Invalid body type");
        if let Some(mass) = body.mass {
            ensure!(
                mass.is_finite() && (0.1..=1e12).contains(&mass),
                "Invalid body mass"
            );
        }
        for v in [body.restitution, body.friction].into_iter().flatten() {
            ensure!(
                v.is_finite() && (0.0..=1.0).contains(&v),
                "Invalid body material"
            );
        }
        seats += c.seats.len();
        ensure!(seats <= 256, "Too many seats");
        for seat in &c.seats {
            validate_vector(
                seat.position
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("Seat has no position"))?,
                512.0,
            )?;
            if let Some(q) = &seat.rotation {
                validate_quaternion(q)?;
            }
        }
        decorations += c.decorations.len();
        ensure!(decorations <= 1024, "Too many decorations");
        let mut decoration_ids = HashSet::new();
        for d in &c.decorations {
            ensure!(
                !d.id.is_empty() && decoration_ids.insert(d.id.as_str()),
                "Invalid decoration id"
            );
            ensure!(
                d.color_rgb <= 0xffffff && d.material_id <= 101,
                "Invalid decoration material"
            );
            if let Some(p) = &d.position {
                validate_vector(p, 512.0)?;
            }
            if let Some(q) = &d.rotation {
                validate_quaternion(q)?;
            }
            if let Some(s) = &d.scale {
                validate_vector(s, 256.0)?;
                ensure!(
                    s.x > 0.0 && s.y > 0.0 && s.z > 0.0,
                    "Invalid decoration scale"
                );
            }
        }
        for child in &c.children {
            stack.push((child, depth + 1));
        }
    }
    ensure!(count > 0, "Entity contains no voxels");
    ensure!(e.constraints.len() <= 256, "Too many constraints");
    let mut joints = HashSet::new();
    for j in &e.constraints {
        ensure!(
            !j.id.is_empty() && joints.insert(j.id.as_str()) && (0..=2).contains(&j.r#type),
            "Invalid constraint id or type"
        );
        ensure!(
            j.stiffness.is_finite() && (0.0..=1.0).contains(&j.stiffness),
            "Invalid constraint stiffness"
        );
        for p in [
            &j.anchor_a,
            &j.anchor_b,
            &j.axis_a,
            &j.axis_b,
            &j.reference_a,
            &j.reference_b,
        ]
        .into_iter()
        .flatten()
        {
            validate_vector(p, 1e6)?;
        }
        if let Some(l) = &j.limits {
            ensure!(
                l.min.is_finite()
                    && l.max.is_finite()
                    && l.min.abs() <= 10000.0
                    && l.max.abs() <= 10000.0,
                "Invalid constraint limits"
            );
        }
        ensure!(
            ids.contains(j.body_b_component_id.as_str())
                && j.body_a_component_id
                    .as_ref()
                    .is_none_or(|a| ids.contains(a.as_str())),
            "Constraint references missing component"
        );
    }
    Ok(())
}
fn validate_vector(p: &inventory::Vector3, limit: f64) -> Result<()> {
    ensure!(
        [p.x, p.y, p.z]
            .iter()
            .all(|v| v.is_finite() && v.abs() <= limit),
        "Invalid vector"
    );
    Ok(())
}
fn validate_quaternion(q: &inventory::Quaternion) -> Result<()> {
    let norm = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
    ensure!(
        norm.is_finite() && (norm - 1.0).abs() < 1e-6,
        "Invalid rotation"
    );
    Ok(())
}
pub fn entity_voxel_count(e: &inventory::Entity) -> usize {
    fn n(c: &inventory::Component) -> usize {
        c.blocks.len() + c.children.iter().map(n).sum::<usize>()
    }
    e.root.as_ref().map_or(0, n)
}
pub fn canonicalize(value: &mut inventory::InventoryResource) {
    fn number(v: &mut f64) {
        if *v == 0.0 {
            *v = 0.0;
        }
    }
    fn vector(p: &mut Option<inventory::Vector3>) {
        if let Some(p) = p {
            number(&mut p.x);
            number(&mut p.y);
            number(&mut p.z);
        }
    }
    fn quaternion(q: &mut Option<inventory::Quaternion>, sign: bool) {
        if let Some(q) = q {
            if sign {
                let first = [q.w, q.x, q.y, q.z]
                    .into_iter()
                    .find(|v| *v != 0.0)
                    .unwrap_or(1.0);
                if first < 0.0 {
                    q.x = -q.x;
                    q.y = -q.y;
                    q.z = -q.z;
                    q.w = -q.w;
                }
            }
            number(&mut q.x);
            number(&mut q.y);
            number(&mut q.z);
            number(&mut q.w);
        }
    }
    fn identity(q: &Option<inventory::Quaternion>) -> bool {
        q.as_ref()
            .is_some_and(|q| q.x == 0.0 && q.y == 0.0 && q.z == 0.0 && q.w.abs() == 1.0)
    }
    fn voxels(v: &mut [inventory::Voxel]) {
        for x in v.iter_mut() {
            if !x.is_micro {
                x.micro_x = 0;
                x.micro_y = 0;
                x.micro_z = 0;
            }
        }
        v.sort_by_key(|v| {
            (
                v.dx,
                v.dy,
                v.dz,
                v.is_micro,
                v.micro_x,
                v.micro_y,
                v.micro_z,
                v.color_rgb,
                v.material_id,
            )
        });
    }
    fn component(c: &mut inventory::Component) {
        vector(&mut c.pivot);
        vector(&mut c.local_position);
        quaternion(&mut c.local_rotation, false);
        quaternion(&mut c.anchor_rotation, false);
        if let Some(body) = &mut c.body {
            for v in [&mut body.mass, &mut body.friction, &mut body.restitution]
                .into_iter()
                .flatten()
            {
                number(v);
            }
        }
        if c.script.is_none() {
            c.script_language.clear();
        } else {
            if c.script_language != "assemblyscript" {
                c.script = Some(String::new());
            }
            c.script_language = "assemblyscript".into();
        }
        for seat in &mut c.seats {
            vector(&mut seat.position);
            quaternion(&mut seat.rotation, false);
            if identity(&seat.rotation) {
                seat.rotation = None;
            }
            if seat.fixed_orientation == Some(false) {
                seat.fixed_orientation = None;
            }
        }
        for d in &mut c.decorations {
            vector(&mut d.position);
            vector(&mut d.scale);
            quaternion(&mut d.rotation, true);
            if d.position
                .as_ref()
                .is_some_and(|p| p.x == 0.0 && p.y == 0.0 && p.z == 0.0)
            {
                d.position = None;
            }
            if d.scale
                .as_ref()
                .is_some_and(|s| s.x == 1.0 && s.y == 1.0 && s.z == 1.0)
            {
                d.scale = None;
            }
            if identity(&d.rotation) {
                d.rotation = None;
            }
        }
        voxels(&mut c.blocks);
        c.children.sort_by(|a, b| a.id.cmp(&b.id));
        c.decorations.sort_by(|a, b| a.id.cmp(&b.id));
        for child in &mut c.children {
            component(child);
        }
    }
    fn entity(e: &mut inventory::Entity) {
        if let Some(c) = &mut e.root {
            component(c);
        }
        e.constraints.sort_by(|a, b| a.id.cmp(&b.id));
        for j in &mut e.constraints {
            for p in [
                &mut j.anchor_a,
                &mut j.anchor_b,
                &mut j.axis_a,
                &mut j.axis_b,
                &mut j.reference_a,
                &mut j.reference_b,
            ] {
                vector(p);
            }
            number(&mut j.stiffness);
            if let Some(l) = &mut j.limits {
                number(&mut l.min);
                number(&mut l.max);
            }
        }
    }
    use inventory::inventory_resource::Content;
    match &mut value.content {
        Some(Content::BlockSet(b)) => voxels(&mut b.blocks),
        Some(Content::Entity(e)) => entity(e),
        Some(Content::Item(i)) => {
            if let Some(b) = &mut i.block_set {
                voxels(&mut b.blocks);
            }
            for e in &mut i.entity_list {
                if let Some(root) = &mut e.root {
                    if root
                        .local_position
                        .as_ref()
                        .is_some_and(|p| p.x == 0.0 && p.y == 0.0 && p.z == 0.0)
                    {
                        root.local_position = None;
                    }
                    quaternion(&mut root.local_rotation, true);
                    if identity(&root.local_rotation) {
                        root.local_rotation = None;
                    }
                }
                entity(e);
            }
            if i.block_set.as_ref().is_some_and(|b| b.blocks.is_empty()) {
                i.block_set = None;
            }
        }
        _ => {}
    }
}
pub fn encode(value: &inventory::InventoryResource) -> Result<Vec<u8>> {
    validate(value)?;
    let mut value = value.clone();
    canonicalize(&mut value);
    let bytes = value.encode_to_vec();
    ensure!(bytes.len() <= MAX_RESOURCE_BYTES, "Resource too large");
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_micro() {
        let v = inventory::Voxel {
            is_micro: true,
            micro_x: 8,
            ..Default::default()
        };
        assert!(validate_voxels(&[v]).is_err());
    }
    #[test]
    fn reads_fixture_roundtrip() {
        let value = inventory::InventoryResource {
            schema_version: 8,
            content: Some(inventory::inventory_resource::Content::BlockSet(
                inventory::BlockSet {
                    name: "black".into(),
                    blocks: vec![inventory::Voxel {
                        color_rgb: 0,
                        ..Default::default()
                    }],
                },
            )),
        };
        assert_eq!(decode(&encode(&value).unwrap()).unwrap(), value);
    }
}
