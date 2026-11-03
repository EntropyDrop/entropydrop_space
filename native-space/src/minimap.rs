//! Low-cost local map tiles, updated from resident terrain without new streaming demand.
use crate::world::{World, index};
use std::collections::HashMap;
#[derive(Default)]
pub struct Minimap {
    pub tiles: HashMap<(i32, i32), [u32; 16]>,
    revision: u64,
    pub center: (i32, i32),
}
impl Minimap {
    pub fn refresh(&mut self, world: &World) {
        if self.revision == world.revision && self.tiles.len() == world.chunks.len() {
            return;
        }
        self.tiles.retain(|key, _| world.chunks.contains_key(key));
        for (&key, chunk) in &world.chunks {
            if self.tiles.contains_key(&key) && self.revision == world.revision {
                continue;
            }
            let mut colors = [0x18222a; 16];
            for z in 0..4 {
                for x in 0..4 {
                    for y in (0..256).rev() {
                        let cell = chunk.cells[index(x * 4 + 2, y, z * 4 + 2)];
                        if cell != 0 {
                            colors[z * 4 + x] = cell & 0xffffff;
                            break;
                        }
                    }
                }
            }
            self.tiles.insert(key, colors);
        }
        self.revision = world.revision;
    }
}
