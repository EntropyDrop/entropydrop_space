use crate::protocol::inventory::{GradientStop, PaletteEntry};
use serde::{Deserialize, Serialize};

pub const PRESETS: [u32; 9] = [
    0xf2a93b, 0x48dbfb, 0x2ed573, 0xeb4d4b, 0xa55eea, 0xf5f6fa, 0x2f3542, 0xff6b81, 0xf1c40f,
];
#[derive(Clone, Serialize, Deserialize)]
pub struct Palette {
    pub entries: Vec<PaletteEntry>,
    pub selected: usize,
}
impl Default for Palette {
    fn default() -> Self {
        Self {
            entries: PRESETS.into_iter().map(|color| solid(color, 0)).collect(),
            selected: 0,
        }
    }
}
pub fn solid(color: u32, material: u32) -> PaletteEntry {
    PaletteEntry {
        stops: vec![GradientStop {
            color_rgb: color & 0xffffff,
            offset_millis: 0,
        }],
        material_id: material.min(101),
    }
}
pub fn normalize(entry: &mut PaletteEntry) {
    entry.material_id = entry.material_id.min(101);
    entry.stops.truncate(5);
    if entry.stops.is_empty() {
        entry.stops.push(GradientStop {
            color_rgb: PRESETS[0],
            offset_millis: 0,
        });
    }
    for stop in &mut entry.stops {
        stop.offset_millis = stop.offset_millis.min(1000);
        stop.color_rgb &= 0xffffff;
    }
    entry.stops.sort_by_key(|stop| stop.offset_millis);
}
pub fn sample(entry: &PaletteEntry, progress: f64) -> u32 {
    let Some(first) = entry.stops.first() else {
        return PRESETS[0];
    };
    let t = if progress.is_finite() {
        progress.clamp(0.0, 1.0) * 1000.0
    } else {
        0.0
    };
    let mut left = first;
    let mut right = entry.stops.last().unwrap();
    for pair in entry.stops.windows(2) {
        if t <= pair[1].offset_millis as f64 {
            left = &pair[0];
            right = &pair[1];
            break;
        }
    }
    if t <= left.offset_millis as f64 || right.offset_millis <= left.offset_millis {
        return left.color_rgb;
    }
    if t >= right.offset_millis as f64 {
        return right.color_rgb;
    }
    let a = (t - left.offset_millis as f64) / (right.offset_millis - left.offset_millis) as f64;
    [16, 8, 0].into_iter().fold(0, |rgb, shift| {
        let from = ((left.color_rgb >> shift) & 255) as f64;
        let to = ((right.color_rgb >> shift) & 255) as f64;
        rgb | (((from + (to - from) * a).round() as u32) << shift)
    })
}
