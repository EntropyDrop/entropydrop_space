//! Exact quarter-turns shared by the Hammer preview and committed resource.
use crate::{
    entity_edit as tree,
    protocol::{self, inventory as pb},
};
use anyhow::{Result, ensure};
use glam::{DQuat, DVec3};
pub fn quarter(axis: usize, direction: i32) -> DQuat {
    DQuat::from_axis_angle(
        [DVec3::X, DVec3::Y, DVec3::Z][axis],
        std::f64::consts::FRAC_PI_2
            * direction.signum() as f64
            * if axis == 1 { -1.0 } else { 1.0 },
    )
}
fn blocks(blocks: &mut [pb::Voxel], q: DQuat) {
    for v in blocks {
        let p = crate::interaction::voxel(v);
        let size = p[3];
        let min = (q * (DVec3::new(p[0], p[1], p[2]) + DVec3::splat(size * 0.5))
            - DVec3::splat(size * 0.5))
            * 8.0;
        let p = min.round().as_ivec3();
        v.dx = p.x.div_euclid(8);
        v.dy = p.y.div_euclid(8);
        v.dz = p.z.div_euclid(8);
        if v.is_micro {
            v.micro_x = p.x.rem_euclid(8) as u32;
            v.micro_y = p.y.rem_euclid(8) as u32;
            v.micro_z = p.z.rem_euclid(8) as u32;
        }
    }
}
pub fn rotate(
    resource: &pb::InventoryResource,
    axis: usize,
    direction: i32,
) -> Result<pb::InventoryResource> {
    ensure!(axis < 3 && direction != 0, "Invalid rotation");
    let q = quarter(axis, direction);
    let mut out = resource.clone();
    use pb::inventory_resource::Content;
    match out.content.as_mut() {
        Some(Content::BlockSet(b)) => blocks(&mut b.blocks, q),
        Some(Content::Entity(e)) => {
            if let Some(root) = &mut e.root {
                root.local_position = Some(tree::pb_vector(
                    q * tree::vector(root.local_position.as_ref()),
                ));
                root.local_rotation = Some(tree::pb_quaternion(
                    q * tree::quaternion(root.local_rotation.as_ref()),
                ));
            }
        }
        Some(Content::Item(item)) => {
            if let Some(b) = &mut item.block_set {
                blocks(&mut b.blocks, q);
            }
            for e in &mut item.entity_list {
                if let Some(root) = &mut e.root {
                    root.local_position = Some(tree::pb_vector(
                        q * tree::vector(root.local_position.as_ref()),
                    ));
                    root.local_rotation = Some(tree::pb_quaternion(
                        q * tree::quaternion(root.local_rotation.as_ref()),
                    ));
                }
                for c in &mut e.constraints {
                    if c.body_a_component_id.is_none() {
                        for v in [&mut c.anchor_a, &mut c.axis_a, &mut c.reference_a]
                            .into_iter()
                            .flatten()
                        {
                            *v = tree::pb_vector(q * tree::vector(Some(v)));
                        }
                    }
                }
            }
        }
        _ => anyhow::bail!("Choose a block set or item to rotate"),
    };
    protocol::validate(&out)?;
    Ok(out)
}
