//! Native glyph rasterization and the Web text-mask-to-voxel contract.
use crate::{protocol, protocol::inventory as pb};
use ab_glyph::{Font, FontRef, ScaleFont, point};
use anyhow::{Result, ensure};
use std::collections::BTreeSet;
pub fn create(
    text: &str,
    size: u32,
    micro: bool,
    rgb: u32,
    material: u32,
) -> Result<pb::InventoryResource> {
    ensure!(!text.trim().is_empty(), "Enter visible text");
    ensure!(
        text.chars().count() <= 256,
        "Text is limited to 256 characters"
    );
    ensure!((8..=128).contains(&size), "Font size must be 8–128 cells");
    let font = FontRef::try_from_slice(include_bytes!("../assets/fonts/fusion-pixel.ttf"))?;
    // CSS px is the em size; ab_glyph's scale is ascent minus descent.
    let px = size as f32 * font.height_unscaled() / font.units_per_em().unwrap_or(12.0);
    let scaled = font.as_scaled(px);
    let line_height = (size as f32 * 1.25).ceil();
    let mut pixels = BTreeSet::new();
    for (line_index, line) in text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .enumerate()
    {
        let mut x = 0.0;
        let mut previous = None;
        for character in line.chars() {
            let id = scaled.glyph_id(character);
            if let Some(prev) = previous {
                x += scaled.kern(prev, id);
            }
            let mut glyph = id.with_scale(px);
            glyph.position = point(x, scaled.ascent() + line_index as f32 * line_height);
            if let Some(outline) = font.outline_glyph(glyph) {
                let bounds = outline.px_bounds();
                outline.draw(|gx, gy, alpha| {
                    if alpha >= 0.5 {
                        pixels.insert((
                            bounds.min.x as i32 + gx as i32,
                            bounds.min.y as i32 + gy as i32,
                        ));
                    }
                });
            }
            x += scaled.h_advance(id);
            previous = Some(id);
        }
        ensure!(pixels.len() <= 65536, "Text exceeds 65,536 voxels");
    }
    ensure!(!pixels.is_empty(), "Text contains no visible glyphs");
    let min_x = pixels.iter().map(|p| p.0).min().unwrap();
    let max_x = pixels.iter().map(|p| p.0).max().unwrap();
    let min_y = pixels.iter().map(|p| p.1).min().unwrap();
    let max_y = pixels.iter().map(|p| p.1).max().unwrap();
    let divisor = if micro { 8 } else { 1 };
    ensure!(
        max_x - min_x < 256 * divisor && max_y - min_y < 256 * divisor,
        "Text exceeds 256 m"
    );
    let blocks = pixels
        .into_iter()
        .map(|(x, y)| {
            let x = x - min_x;
            let y = max_y - y;
            pb::Voxel {
                dx: x / divisor,
                dy: y / divisor,
                dz: 0,
                is_micro: micro,
                micro_x: if micro { (x % 8) as u32 } else { 0 },
                micro_y: if micro { (y % 8) as u32 } else { 0 },
                micro_z: 0,
                color_rgb: rgb,
                material_id: material,
            }
        })
        .collect();
    let resource = pb::InventoryResource {
        schema_version: 8,
        content: Some(pb::inventory_resource::Content::BlockSet(pb::BlockSet {
            name: "Text".into(),
            blocks,
        })),
    };
    protocol::validate(&resource)?;
    Ok(resource)
}
