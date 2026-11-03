//! Authored component editing. Simulation is not used to implement UI commands.
use crate::{
    editor::PlacedEntity,
    protocol::{self, inventory as pb},
};
use anyhow::{Context, Result, ensure};
use glam::{DMat4, DQuat, DVec3};
use std::collections::{HashMap, HashSet};

pub fn vector(v: Option<&pb::Vector3>) -> DVec3 {
    v.map_or(DVec3::ZERO, |v| DVec3::new(v.x, v.y, v.z))
}
pub fn quaternion(v: Option<&pb::Quaternion>) -> DQuat {
    v.map_or(DQuat::IDENTITY, |v| DQuat::from_xyzw(v.x, v.y, v.z, v.w))
}
pub fn pb_vector(v: DVec3) -> pb::Vector3 {
    pb::Vector3 {
        x: v.x,
        y: v.y,
        z: v.z,
    }
}
pub fn pb_quaternion(v: DQuat) -> pb::Quaternion {
    pb::Quaternion {
        x: v.x,
        y: v.y,
        z: v.z,
        w: v.w,
    }
}
pub fn local(c: &pb::Component) -> DMat4 {
    DMat4::from_rotation_translation(
        quaternion(c.local_rotation.as_ref()),
        vector(c.local_position.as_ref()),
    )
}
pub fn pose(e: &PlacedEntity) -> DMat4 {
    DMat4::from_rotation_translation(DQuat::from_array(e.rotation), DVec3::from_array(e.position))
}
pub fn find<'a>(root: &'a pb::Component, id: &str) -> Option<&'a pb::Component> {
    if root.id == id {
        return Some(root);
    }
    root.children.iter().find_map(|child| find(child, id))
}
pub fn find_mut<'a>(root: &'a mut pb::Component, id: &str) -> Option<&'a mut pb::Component> {
    if root.id == id {
        return Some(root);
    }
    root.children
        .iter_mut()
        .find_map(|child| find_mut(child, id))
}
pub fn ids(root: &pb::Component) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut stack = vec![root];
    while let Some(c) = stack.pop() {
        out.insert(c.id.clone());
        stack.extend(&c.children);
    }
    out
}
/// Shared engine defaults every unspecified pivot to the entity's voxel bounds center.
pub fn center(root: &pb::Component) -> DVec3 {
    let mut min = DVec3::splat(f64::INFINITY);
    let mut max = DVec3::splat(f64::NEG_INFINITY);
    let mut nodes = vec![root];
    while let Some(c) = nodes.pop() {
        nodes.extend(&c.children);
        for v in &c.blocks {
            let v = crate::interaction::voxel(v);
            let p = DVec3::new(v[0], v[1], v[2]);
            min = min.min(p);
            max = max.max(p + DVec3::splat(v[3]));
        }
    }
    if min.is_finite() {
        (min + max) * 0.5
    } else {
        DVec3::splat(0.5)
    }
}
pub fn pivot(root: &pb::Component, c: &pb::Component) -> DVec3 {
    c.pivot
        .as_ref()
        .map_or_else(|| center(root), |p| vector(Some(p)))
}
pub fn frame(root: &pb::Component, id: &str) -> Option<DMat4> {
    fn visit(
        c: &pb::Component,
        id: &str,
        parent: DMat4,
        parent_pivot: DVec3,
        fallback: DVec3,
        is_root: bool,
    ) -> Option<DMat4> {
        let pivot = c.pivot.as_ref().map_or(fallback, |v| vector(Some(v)));
        let pos = if is_root {
            vector(c.local_position.as_ref()) + quaternion(c.local_rotation.as_ref()) * pivot
        } else {
            c.local_position
                .as_ref()
                .map_or(pivot - parent_pivot, |v| vector(Some(v)))
        };
        let m =
            parent * DMat4::from_rotation_translation(quaternion(c.local_rotation.as_ref()), pos);
        if c.id == id {
            return Some(m);
        }
        c.children
            .iter()
            .find_map(|child| visit(child, id, m, pivot, fallback, false))
    }
    visit(root, id, DMat4::IDENTITY, DVec3::ZERO, center(root), true)
}
pub fn matrix(root: &pb::Component, id: &str) -> Option<DMat4> {
    Some(frame(root, id)? * DMat4::from_translation(-pivot(root, find(root, id)?)))
}
pub fn freeze_pivots(root: &mut pb::Component) {
    fn visit(c: &mut pb::Component, fallback: DVec3) {
        if c.pivot.is_none() {
            c.pivot = Some(pb_vector(fallback));
        }
        for child in &mut c.children {
            visit(child, fallback);
        }
    }
    let fallback = center(root);
    visit(root, fallback);
}
/// Move the pivot without moving geometry, descendants, seats or joint anchors in world space.
pub fn set_pivot(entity: &mut PlacedEntity, id: &str, target: DVec3) -> Result<()> {
    ensure!(
        !entity.running && target.is_finite(),
        "Stop the entity before editing its pivot"
    );
    let root = entity
        .definition
        .root
        .as_mut()
        .context("Entity has no root")?;
    freeze_pivots(root);
    let root_id = root.id.clone();
    let node = find_mut(root, id).context("Component no longer exists")?;
    ensure!(
        node.body.as_ref().is_some_and(|b| b.r#type == 1),
        "Only kinematic component pivots can be edited"
    );
    let delta = target - vector(node.pivot.as_ref());
    let rotation = if id == root_id {
        DQuat::from_array(entity.rotation)
    } else {
        quaternion(node.local_rotation.as_ref())
    };
    if id == root_id {
        // Native stores the voxel origin; shifting the pivot leaves that origin fixed.
    } else {
        node.local_position = Some(pb_vector(
            vector(node.local_position.as_ref()) + rotation * delta,
        ));
    }
    for child in &mut node.children {
        if let Some(p) = &mut child.local_position {
            *p = pb_vector(vector(Some(p)) - delta);
        }
    }
    node.pivot = Some(pb_vector(target));
    Ok(())
}

fn take(root: &mut pb::Component, id: &str) -> Option<pb::Component> {
    if let Some(index) = root.children.iter().position(|c| c.id == id) {
        return Some(root.children.remove(index));
    }
    root.children.iter_mut().find_map(|c| take(c, id))
}
pub fn stopped_body() -> pb::BodyConfig {
    pb::BodyConfig {
        r#type: 1,
        use_gravity: Some(false),
        collision_enabled: Some(true),
        restitution: Some(0.1),
        friction: Some(0.7),
        mass: None,
    }
}
pub fn unique_id(root: &pb::Component, preferred: &str) -> String {
    let occupied = ids(root);
    if !occupied.contains(preferred) {
        return preferred.into();
    }
    for i in 2.. {
        let value = format!("{preferred}-{i}");
        if !occupied.contains(&value) {
            return value;
        }
    }
    unreachable!()
}
pub fn rename(entity: &mut pb::Entity, old: &str, new: &str) -> Result<()> {
    let new = new.trim();
    ensure!(
        !new.is_empty() && new.chars().count() <= 128,
        "Component id must contain 1–128 characters"
    );
    let root = entity.root.as_mut().context("Entity has no root")?;
    ensure!(
        old == new || find(root, new).is_none(),
        "Component id already exists"
    );
    find_mut(root, old)
        .context("Component no longer exists")?
        .id = new.into();
    for joint in &mut entity.constraints {
        if joint.body_a_component_id.as_deref() == Some(old) {
            joint.body_a_component_id = Some(new.into());
        }
        if joint.body_b_component_id == old {
            joint.body_b_component_id = new.into();
        }
    }
    Ok(())
}
pub fn remove(entity: &mut pb::Entity, id: &str) -> Result<pb::Component> {
    let root = entity.root.as_mut().context("Entity has no root")?;
    ensure!(root.id != id, "Delete the entity to remove its root");
    let removed = take(root, id).context("Component no longer exists")?;
    let deleted = ids(&removed);
    entity.constraints.retain(|j| {
        !deleted.contains(&j.body_b_component_id)
            && j.body_a_component_id
                .as_ref()
                .is_none_or(|id| !deleted.contains(id))
    });
    Ok(removed)
}
pub fn reparent(entity: &mut pb::Entity, id: &str, parent: &str) -> Result<()> {
    let root = entity.root.as_ref().context("Entity has no root")?;
    ensure!(root.id != id, "The root cannot be reparented");
    let node = find(root, id).context("Component no longer exists")?;
    ensure!(
        !ids(node).contains(parent),
        "A component cannot be parented to its own subtree"
    );
    let transform = frame(root, parent)
        .context("Parent no longer exists")?
        .inverse()
        * frame(root, id).unwrap();
    let root = entity.root.as_mut().unwrap();
    freeze_pivots(root);
    let mut node = take(root, id).unwrap();
    let (_, rotation, position) = transform.to_scale_rotation_translation();
    node.local_position = Some(pb_vector(position));
    node.local_rotation = Some(pb_quaternion(rotation.normalize()));
    find_mut(root, parent).unwrap().children.push(node);
    Ok(())
}
pub fn detach(entity: &PlacedEntity, id: &str) -> Result<(PlacedEntity, PlacedEntity)> {
    ensure!(
        !entity.running,
        "Stop the entity before detaching a component"
    );
    let root = entity
        .definition
        .root
        .as_ref()
        .context("Entity has no root")?;
    let transform = pose(entity) * matrix(root, id).context("Component no longer exists")?;
    let mut source = entity.clone();
    freeze_pivots(source.definition.root.as_mut().unwrap());
    let mut subtree = remove(&mut source.definition, id)?;
    let owned = ids(&subtree);
    subtree.local_position = None;
    subtree.local_rotation = None;
    let constraints = entity
        .definition
        .constraints
        .iter()
        .filter(|j| {
            owned.contains(&j.body_b_component_id)
                && j.body_a_component_id
                    .as_ref()
                    .is_none_or(|id| owned.contains(id))
        })
        .cloned()
        .collect();
    let (_, rotation, position) = transform.to_scale_rotation_translation();
    let mut detached = PlacedEntity::new(
        pb::Entity {
            root: Some(subtree),
            constraints,
        },
        position,
    );
    detached.rotation = rotation.to_array();
    protocol::validate_entity(&source.definition)?;
    protocol::validate_entity(&detached.definition)?;
    Ok((source, detached))
}
pub fn merge(target: &PlacedEntity, source: &PlacedEntity, parent: &str) -> Result<PlacedEntity> {
    ensure!(
        !source.running && !target.running,
        "Stop both entities before attaching"
    );
    ensure!(source.id != target.id, "Cannot attach an entity to itself");
    let target_root = target
        .definition
        .root
        .as_ref()
        .context("Target has no root")?;
    let source_root = source
        .definition
        .root
        .as_ref()
        .context("Source has no root")?;
    let target_parent =
        pose(target) * frame(target_root, parent).context("Parent no longer exists")?;
    let relative =
        target_parent.inverse() * pose(source) * frame(source_root, &source_root.id).unwrap();
    let (_, rotation, position) = relative.to_scale_rotation_translation();
    let mut result = target.clone();
    freeze_pivots(result.definition.root.as_mut().unwrap());
    let mut child = source_root.clone();
    freeze_pivots(&mut child);
    let mut occupied = ids(target_root);
    let mut mapping = HashMap::new();
    fn remap(
        node: &mut pb::Component,
        occupied: &mut HashSet<String>,
        mapping: &mut HashMap<String, String>,
    ) {
        let old = node.id.clone();
        let mut new = old.clone();
        let mut n = 2;
        while occupied.contains(&new) {
            new = format!("{old}-{n}");
            n += 1;
        }
        occupied.insert(new.clone());
        mapping.insert(old, new.clone());
        node.id = new;
        for child in &mut node.children {
            remap(child, occupied, mapping);
        }
    }
    remap(&mut child, &mut occupied, &mut mapping);
    child.local_position = Some(pb_vector(position));
    child.local_rotation = Some(pb_quaternion(rotation.normalize()));
    find_mut(result.definition.root.as_mut().unwrap(), parent)
        .unwrap()
        .children
        .push(child);
    let mut joint_ids: HashSet<_> = result
        .definition
        .constraints
        .iter()
        .map(|j| j.id.clone())
        .collect();
    for joint in &source.definition.constraints {
        let mut j = joint.clone();
        if joint_ids.contains(&j.id) {
            j.id = uuid::Uuid::new_v4().to_string();
        }
        joint_ids.insert(j.id.clone());
        if let Some(id) = &j.body_a_component_id {
            j.body_a_component_id = Some(mapping[id].clone());
        }
        j.body_b_component_id = mapping[&j.body_b_component_id].clone();
        result.definition.constraints.push(j);
    }
    protocol::validate_entity(&result.definition)?;
    Ok(result)
}
pub fn cube_rotation(q: DQuat) -> DQuat {
    let mut best = DQuat::IDENTITY;
    let mut dot = -1.0_f64;
    for x in 0..4 {
        for y in 0..4 {
            for z in 0..4 {
                let c = DQuat::from_euler(
                    glam::EulerRot::XYZ,
                    x as f64 * std::f64::consts::FRAC_PI_2,
                    y as f64 * std::f64::consts::FRAC_PI_2,
                    z as f64 * std::f64::consts::FRAC_PI_2,
                );
                let d = c.dot(q).abs();
                if d > dot {
                    dot = d;
                    best = c;
                }
            }
        }
    }
    best
}
pub fn world_voxels(
    entity: &PlacedEntity,
    snap_rotation: bool,
) -> Result<Vec<(crate::world::Cell, u32)>> {
    let mut transform = pose(entity);
    if snap_rotation {
        transform = DMat4::from_rotation_translation(
            cube_rotation(DQuat::from_array(entity.rotation)),
            DVec3::from_array(entity.position),
        );
    }
    fn collect(
        c: &pb::Component,
        root: &pb::Component,
        parent: DMat4,
        out: &mut Vec<(crate::world::Cell, u32)>,
    ) -> Result<()> {
        let transform = parent * matrix(root, &c.id).unwrap();
        for v in &c.blocks {
            let data = crate::interaction::voxel(v);
            let scale = if v.is_micro { 8.0 } else { 1.0 };
            let point = transform.transform_point3(
                DVec3::new(data[0], data[1], data[2]) + DVec3::splat(data[3] * 0.5),
            ) - DVec3::splat(data[3] * 0.5);
            let p = (point * scale).round();
            ensure!(
                (0.0..256.0 * scale).contains(&p.y),
                "Entity crosses world height limits"
            );
            out.push((
                crate::world::Cell::new(p.x as i32, p.y as i32, p.z as i32, v.is_micro),
                crate::world::color(v.color_rgb, v.material_id),
            ));
        }
        for child in &c.children {
            collect(child, root, parent, out)?;
        }
        Ok(())
    }
    let mut out = Vec::new();
    collect(
        entity
            .definition
            .root
            .as_ref()
            .context("Entity has no root")?,
        entity.definition.root.as_ref().unwrap(),
        transform,
        &mut out,
    )?;
    Ok(out)
}
