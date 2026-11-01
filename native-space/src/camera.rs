use crate::geometry::{WORLD_X, WORLD_Z};
use crate::world::{Cell, World};
use glam::DVec3;

pub struct Camera {
    pub position: DVec3,
    pub yaw: f64,
    pub pitch: f64,
    pub flying: bool,
    pub speed: f64,
    pub velocity: DVec3,
    pub grounded: bool,
}
impl Camera {
    pub fn new(position: DVec3) -> Self {
        Self {
            position,
            yaw: 0.0,
            pitch: -0.15,
            flying: true,
            speed: 12.0,
            velocity: DVec3::ZERO,
            grounded: false,
        }
    }
    pub fn overlooking(spawn: DVec3) -> Self {
        let mut camera = Self::new(spawn + DVec3::new(30.0, 25.0, 45.0));
        let direction = (spawn - DVec3::Y * 25.0 - camera.position).normalize();
        camera.yaw = direction.x.atan2(-direction.z);
        camera.pitch = direction.y.asin();
        camera
    }
    pub fn direction(&self) -> DVec3 {
        DVec3::new(
            self.yaw.sin() * self.pitch.cos(),
            self.pitch.sin(),
            -self.yaw.cos() * self.pitch.cos(),
        )
    }
    pub fn look(&mut self, x: f64, y: f64) {
        self.yaw += x * 0.002;
        self.pitch = (self.pitch - y * 0.002).clamp(-1.55, 1.55);
    }
    pub fn update(&mut self, world: &World, input: DVec3, boost: bool, jump: bool, dt: f64) {
        let dt = dt.min(0.05);
        let forward = if self.flying {
            self.direction()
        } else {
            DVec3::new(self.yaw.sin(), 0.0, -self.yaw.cos())
        };
        let right = DVec3::new(self.yaw.cos(), 0.0, self.yaw.sin());
        let motion = (right * input.x
            + forward * input.z
            + DVec3::Y * if self.flying { input.y } else { 0.0 })
        .normalize_or_zero();
        let speed = if self.flying { self.speed } else { 5.0 } * if boost { 3.0 } else { 1.0 };
        if self.flying {
            self.position += motion * speed * dt;
            self.velocity = DVec3::ZERO;
        } else {
            self.velocity.x = motion.x * speed;
            self.velocity.z = motion.z * speed;
            if jump && self.grounded {
                self.velocity.y = 7.2;
            }
            self.velocity.y = (self.velocity.y - 20.0 * dt).max(-50.0);
            self.grounded = false;
            let steps = (self.velocity.length() * dt / 0.1).ceil().max(1.0) as usize;
            for _ in 0..steps {
                for axis in [0, 2, 1] {
                    let mut next = self.position;
                    next[axis] += self.velocity[axis] * dt / steps as f64;
                    let feet = next - DVec3::Y * 1.65;
                    let mut blocked = false;
                    for x in [-0.28, 0.0, 0.28] {
                        for z in [-0.28, 0.0, 0.28] {
                            for h in [0.01, 0.45, 0.9, 1.35, 1.75] {
                                let p = feet + DVec3::new(x, h, z);
                                let c = Cell::new(
                                    p.x.floor() as i32,
                                    p.y.floor() as i32,
                                    p.z.floor() as i32,
                                    false,
                                );
                                if !world.chunks.contains_key(&c.chunk()) || world.solid_at(p) {
                                    blocked = true;
                                }
                            }
                        }
                    }
                    if blocked {
                        if axis == 1 && self.velocity.y < 0.0 {
                            self.grounded = true;
                        }
                        self.velocity[axis] = 0.0;
                    } else {
                        self.position = next;
                    }
                }
            }
        }
        self.position.x = self.position.x.rem_euclid(WORLD_X as f64);
        self.position.z = self.position.z.rem_euclid(WORLD_Z as f64);
    }
}
