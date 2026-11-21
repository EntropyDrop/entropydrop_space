use rapier3d::prelude::*;
use serde::{Deserialize, Serialize};
use std::{hint::black_box, io, time::Instant};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Body {
    fixed: bool,
    position: [f32; 3],
    rotation: [f32; 4],
    velocity: [f32; 3],
    angular: [f32; 3],
    mass: f32,
    inertia: f32,
    damping: f32,
    angular_damping: f32,
    friction: f32,
    restitution: f32,
    collider: bool,
}

#[derive(Deserialize)]
struct Shape {
    center: [f32; 3],
    half: [f32; 3],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Joint {
    a: usize,
    b: usize,
    anchor_a: [f32; 3],
    anchor_b: [f32; 3],
    axis: [f32; 3],
    limits: [f32; 2],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    name: String,
    timestep: f32,
    substeps: usize,
    warmup: usize,
    ticks: usize,
    rounds: usize,
    quality_ticks: usize,
    gravity: [f32; 3],
    terrain: Vec<Shape>,
    remove_terrain: Option<usize>,
    bodies: Vec<Body>,
    joints: Vec<Joint>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Timing {
    update: Vec<f64>,
    edited_update: Vec<f64>,
    quality_frames: Vec<Vec<f64>>,
}

struct Simulation {
    world: PhysicsWorld,
    bodies: Vec<RigidBodyHandle>,
    terrain: Vec<ColliderHandle>,
    substeps: usize,
}

impl Simulation {
    fn new(fixture: &Fixture) -> Self {
        let mut world = PhysicsWorld::new();
        world.gravity = Vector::from_array(fixture.gravity);
        world.integration_parameters.dt = fixture.timestep;
        let bodies: Vec<_> = fixture
            .bodies
            .iter()
            .map(|spec| {
                let builder = if spec.fixed {
                    RigidBodyBuilder::fixed()
                } else {
                    RigidBodyBuilder::dynamic()
                };
                let [x, y, z, w] = spec.rotation;
                let pose = Pose::from_parts(
                    Vector::from_array(spec.position),
                    Rotation::from_xyzw(x, y, z, w),
                );
                let mass =
                    MassProperties::new(Vector::ZERO, spec.mass, Vector::splat(spec.inertia));
                let gravity_scale = if fixture.name == "hinges" { 0.0 } else { 1.0 };
                let body = world.insert_body(
                    builder
                        .pose(pose)
                        .linvel(Vector::from_array(spec.velocity))
                        .angvel(Vector::from_array(spec.angular))
                        .gravity_scale(gravity_scale)
                        .can_sleep(false)
                        .ccd_enabled(spec.collider)
                        .linear_damping(spec.damping)
                        .angular_damping(spec.angular_damping)
                        .additional_mass_properties(mass),
                );
                if spec.collider {
                    world.insert_collider(
                        ColliderBuilder::cuboid(0.5, 0.5, 0.5)
                            .density(0.0)
                            .friction(spec.friction)
                            .restitution(spec.restitution),
                        Some(body),
                    );
                }
                body
            })
            .collect();
        let terrain = fixture
            .terrain
            .iter()
            .map(|shape| {
                let [x, y, z] = shape.half;
                world.insert_collider(
                    ColliderBuilder::cuboid(x, y, z)
                        .translation(Vector::from_array(shape.center))
                        .friction(0.7),
                    None,
                )
            })
            .collect();
        for joint in &fixture.joints {
            let hinge = RevoluteJointBuilder::new(Vector::from_array(joint.axis))
                .local_anchor1(Vector::from_array(joint.anchor_a))
                .local_anchor2(Vector::from_array(joint.anchor_b))
                .limits(joint.limits)
                .contacts_enabled(false);
            world.insert_impulse_joint(bodies[joint.a], bodies[joint.b], hinge);
        }
        Self {
            world,
            bodies,
            terrain,
            substeps: fixture.substeps,
        }
    }

    fn step(&mut self) {
        for _ in 0..self.substeps {
            self.world.step();
        }
    }

    fn edit(&mut self, index: usize) {
        assert!(self.world.remove_collider(self.terrain[index]).is_some());
    }

    fn publish(&self, state: &mut [f64]) {
        for (&handle, row) in self.bodies.iter().zip(state.chunks_exact_mut(13)) {
            let body = &self.world.bodies[handle];
            let p = body.translation();
            let q = body.rotation();
            let v = body.linvel();
            let w = body.angvel();
            let values = [
                p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z,
            ];
            for (slot, value) in row.iter_mut().zip(values) {
                *slot = f64::from(value);
            }
        }
    }
}

fn run(fixture: &Fixture) -> Timing {
    let mut result = Timing::default();
    let mut state = vec![0.0; fixture.bodies.len() * 13];
    for round in 0..(fixture.rounds + 6) {
        let mut simulation = Simulation::new(fixture);
        for _ in 0..fixture.warmup {
            simulation.step();
            simulation.publish(black_box(&mut state));
        }
        for _ in 0..fixture.ticks {
            let start = Instant::now();
            simulation.step();
            simulation.publish(black_box(&mut state));
            black_box(&state);
            if round >= 6 {
                result.update.push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
        if let Some(index) = fixture.remove_terrain {
            let start = Instant::now();
            simulation.edit(index);
            simulation.step();
            simulation.publish(black_box(&mut state));
            black_box(&state);
            if round >= 6 {
                result
                    .edited_update
                    .push(start.elapsed().as_secs_f64() * 1000.0);
            }
        }
    }

    let mut simulation = Simulation::new(fixture);
    for _ in 0..fixture.warmup {
        simulation.step();
    }
    simulation.publish(&mut state);
    result.quality_frames.push(state.clone());
    if let Some(index) = fixture.remove_terrain {
        simulation.edit(index);
    }
    for _ in 0..fixture.quality_ticks {
        simulation.step();
        simulation.publish(&mut state);
        result.quality_frames.push(state.clone());
    }
    result
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let fixtures: Vec<Fixture> = serde_json::from_reader(io::stdin().lock())?;
    let results: Vec<_> = fixtures.iter().map(run).collect();
    serde_json::to_writer(io::stdout().lock(), &results)?;
    Ok(())
}
