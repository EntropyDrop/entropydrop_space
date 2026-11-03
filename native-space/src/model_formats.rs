//! Native glTF/GLB, FBX and model-archive readers.
use crate::model_import::{Texture, Triangle};
use anyhow::{Context, Result, ensure};
use glam::{DMat4, DVec2, DVec3};
use std::{
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::Arc,
};
const MAX_BYTES: u64 = 128 * 1024 * 1024;
fn rgb(v: [f32; 4]) -> u32 {
    let byte = |x: f32| (x.clamp(0.0, 1.0) * 255.0).round() as u32;
    (byte(v[0]) << 16) | (byte(v[1]) << 8) | byte(v[2])
}
fn image_texture(bytes: &[u8], flip_y: bool) -> Result<Arc<Texture>> {
    ensure!(bytes.len() as u64 <= MAX_BYTES, "Texture exceeds 128 MiB");
    let reader = image::ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    let (w, h) = reader.into_dimensions()?;
    ensure!(
        u64::from(w) * u64::from(h) <= 32_000_000,
        "Texture exceeds 32 million pixels"
    );
    let image = image::load_from_memory(bytes)?.to_rgba8();
    Ok(Arc::new(Texture {
        width: image.width(),
        height: image.height(),
        rgba: image.into_raw(),
        flip_y,
    }))
}
fn local_file(base: &Path, relative: &str) -> Result<PathBuf> {
    let relative = Path::new(relative);
    ensure!(
        !relative.is_absolute()
            && !relative
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir)),
        "Model resources must be within the selected model folder"
    );
    let path = base.join(relative);
    ensure!(
        path.canonicalize()?.starts_with(base.canonicalize()?),
        "Model resource leaves its folder"
    );
    ensure!(
        std::fs::metadata(&path)?.len() <= MAX_BYTES,
        "Model resource exceeds 128 MiB"
    );
    Ok(path)
}
fn decode_uri(uri: &str) -> Result<String> {
    let bytes = uri.as_bytes();
    let mut result = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            ensure!(i + 2 < bytes.len(), "Invalid model resource URI");
            result.push(u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3])?,
                16,
            )?);
            i += 3;
        } else {
            result.push(bytes[i]);
            i += 1;
        }
    }
    Ok(String::from_utf8(result)?)
}
pub fn gltf(path: &Path) -> Result<Vec<Triangle>> {
    let bytes = std::fs::read(path)?;
    ensure!(bytes.len() as u64 <= MAX_BYTES, "Model exceeds 128 MiB");
    let asset = gltf::Gltf::from_slice(&bytes)?;
    let base = path.parent().unwrap_or(Path::new("."));
    ensure!(
        asset.document.buffers().count() + asset.document.images().count() <= 64,
        "Model has more than 64 resources"
    );
    ensure!(
        asset
            .document
            .buffers()
            .map(|b| b.length() as u64)
            .sum::<u64>()
            <= MAX_BYTES,
        "Model buffers exceed 128 MiB"
    );
    for b in asset.document.buffers() {
        if let gltf::buffer::Source::Uri(uri) = b.source()
            && !uri.starts_with("data:")
        {
            local_file(base, &decode_uri(uri)?)?;
        }
    }
    for i in asset.document.images() {
        if let gltf::image::Source::Uri { uri, .. } = i.source()
            && !uri.starts_with("data:")
        {
            local_file(base, &decode_uri(uri)?)?;
        }
    }
    let buffers = gltf::import_buffers(&asset.document, Some(base), asset.blob)?;
    let images = gltf::import_images(&asset.document, Some(base), &buffers)?;
    let mut textures = Vec::new();
    let mut texture_bytes = 0usize;
    for image in images {
        use gltf::image::Format;
        let channels = match image.format {
            Format::R8 => 1,
            Format::R8G8 => 2,
            Format::R8G8B8 => 3,
            Format::R8G8B8A8 => 4,
            _ => anyhow::bail!("Unsupported model image channel format"),
        };
        texture_bytes =
            texture_bytes.saturating_add(image.width as usize * image.height as usize * 4);
        ensure!(
            texture_bytes <= MAX_BYTES as usize,
            "Decoded model textures exceed 128 MiB"
        );
        let mut rgba = Vec::with_capacity(image.width as usize * image.height as usize * 4);
        for p in image.pixels.chunks(channels) {
            match channels {
                1 => rgba.extend_from_slice(&[p[0], p[0], p[0], 255]),
                2 => rgba.extend_from_slice(&[p[0], p[0], p[0], p[1]]),
                3 => rgba.extend_from_slice(&[p[0], p[1], p[2], 255]),
                _ => rgba.extend_from_slice(p),
            }
        }
        textures.push(Arc::new(Texture {
            width: image.width,
            height: image.height,
            rgba,
            flip_y: false,
        }));
    }
    fn visit(
        node: gltf::Node,
        parent: DMat4,
        buffers: &[gltf::buffer::Data],
        textures: &[Arc<Texture>],
        triangles: &mut Vec<Triangle>,
        depth: usize,
    ) -> Result<()> {
        ensure!(depth <= 128, "Model node hierarchy is too deep");
        let local = node.transform().matrix();
        let matrix = parent * glam::Mat4::from_cols_array_2d(&local).as_dmat4();
        if let Some(mesh) = node.mesh() {
            for primitive in mesh.primitives() {
                let reader = primitive.reader(|b| buffers.get(b.index()).map(|b| b.0.as_slice()));
                let points = reader
                    .read_positions()
                    .context("Mesh has no positions")?
                    .map(|p| matrix.transform_point3(glam::Vec3::from_array(p).as_dvec3()))
                    .collect::<Vec<_>>();
                let indices = reader.read_indices().map_or_else(
                    || (0..points.len() as u32).collect::<Vec<_>>(),
                    |i| i.into_u32().collect(),
                );
                let material = primitive.material().pbr_metallic_roughness();
                let legacy = primitive.material().pbr_specular_glossiness();
                let color = rgb(legacy
                    .as_ref()
                    .map_or_else(|| material.base_color_factor(), |m| m.diffuse_factor()));
                let texture_info = legacy
                    .and_then(|m| m.diffuse_texture())
                    .or_else(|| material.base_color_texture());
                let uv_set = texture_info.as_ref().map_or(0, |i| i.tex_coord());
                let uvs = reader.read_tex_coords(uv_set).map(|uv| {
                    uv.into_f32()
                        .map(|p| DVec2::new(p[0] as f64, p[1] as f64))
                        .collect::<Vec<_>>()
                });
                let colors = reader.read_colors(0).map(|c| {
                    c.into_rgba_f32()
                        .map(|p| DVec3::new(p[0] as f64, p[1] as f64, p[2] as f64) * 255.0)
                        .collect::<Vec<_>>()
                });
                let texture = texture_info.map(|i| textures[i.texture().source().index()].clone());
                let mut faces = Vec::new();
                match primitive.mode() {
                    gltf::mesh::Mode::Triangles => {
                        faces.extend(indices.as_chunks::<3>().0.iter().copied())
                    }
                    gltf::mesh::Mode::TriangleStrip => {
                        for i in 2..indices.len() {
                            faces.push(if i % 2 == 0 {
                                [indices[i - 2], indices[i - 1], indices[i]]
                            } else {
                                [indices[i - 1], indices[i - 2], indices[i]]
                            });
                        }
                    }
                    gltf::mesh::Mode::TriangleFan => {
                        for i in 2..indices.len() {
                            faces.push([indices[0], indices[i - 1], indices[i]]);
                        }
                    }
                    _ => continue,
                }
                ensure!(
                    triangles.len() + faces.len() <= 3_000_000,
                    "Model exceeds 3 million triangles"
                );
                for face in faces {
                    let ids = face.map(|i| i as usize);
                    ensure!(ids.iter().all(|i| *i < points.len()), "Invalid mesh index");
                    let vertices = ids.map(|i| points[i]);
                    ensure!(
                        vertices.iter().all(|p| p.is_finite()),
                        "Non-finite model position"
                    );
                    let vertex_colors = colors
                        .as_ref()
                        .filter(|c| ids.iter().all(|i| *i < c.len()))
                        .map(|c| ids.map(|i| c[i]));
                    let uv = uvs
                        .as_ref()
                        .filter(|uv| ids.iter().all(|i| *i < uv.len()))
                        .map(|uv| ids.map(|i| uv[i]));
                    triangles.push(Triangle {
                        vertices,
                        color,
                        vertex_colors,
                        uvs: uv,
                        texture: texture.clone(),
                    });
                }
            }
        }
        for child in node.children() {
            visit(child, matrix, buffers, textures, triangles, depth + 1)?;
        }
        Ok(())
    }
    let mut triangles = Vec::new();
    let scene = asset
        .document
        .default_scene()
        .or_else(|| asset.document.scenes().next())
        .context("Model contains no scene")?;
    for node in scene.nodes() {
        visit(
            node,
            DMat4::IDENTITY,
            &buffers,
            &textures,
            &mut triangles,
            0,
        )?;
    }
    ensure!(!triangles.is_empty(), "Model contains no triangles");
    Ok(triangles)
}
pub fn fbx(path: &Path) -> Result<Vec<Triangle>> {
    ensure!(
        std::fs::metadata(path)?.len() <= MAX_BYTES,
        "Model exceeds 128 MiB"
    );
    let opts = ufbx::LoadOpts {
        target_axes: ufbx::axes_right_handed_y_up(),
        ignore_animation: true,
        load_external_files: false,
        node_depth_limit: 128,
        temp_allocator: ufbx::AllocatorOpts {
            memory_limit: 256 * 1024 * 1024,
            ..Default::default()
        },
        result_allocator: ufbx::AllocatorOpts {
            memory_limit: 512 * 1024 * 1024,
            ..Default::default()
        },
        ..Default::default()
    };
    let scene = ufbx::load_file(path.to_str().context("Invalid model path")?, opts)
        .map_err(|e| anyhow::anyhow!("FBX import: {e:?}"))?;
    let base = path.parent().unwrap_or(Path::new("."));
    let mut textures = std::collections::HashMap::<u32, Arc<Texture>>::new();
    let mut triangles = Vec::new();
    let mut indices = Vec::new();
    for node in &scene.nodes {
        let Some(mesh) = &node.mesh else {
            continue;
        };
        ensure!(
            triangles.len() + mesh.num_triangles <= 3_000_000,
            "Model exceeds 3 million triangles"
        );
        for (face_index, face) in mesh.faces.iter().enumerate() {
            let count = ufbx::triangulate_face_vec(&mut indices, mesh, *face) as usize;
            let material = mesh
                .face_material
                .get(face_index)
                .and_then(|&i| node.materials.get(i as usize));
            let map = material.map(|m| {
                if m.pbr.base_color.has_value {
                    &m.pbr.base_color
                } else {
                    &m.fbx.diffuse_color
                }
            });
            let color = map.filter(|m| m.has_value).map_or(0xffffff, |m| {
                rgb([
                    m.value_vec4.x as f32,
                    m.value_vec4.y as f32,
                    m.value_vec4.z as f32,
                    1.0,
                ])
            });
            let texture = if let Some(t) = map
                .and_then(|m| m.texture.as_ref())
                .filter(|_| mesh.vertex_uv.exists)
            {
                if let Some(texture) = textures.get(&t.element.element_id) {
                    Some(texture.clone())
                } else {
                    let bytes = if !t.content.is_empty() {
                        t.content.to_vec()
                    } else if let Some(video) = &t.video
                        && !video.content.is_empty()
                    {
                        video.content.to_vec()
                    } else {
                        let relative = if !t.relative_filename.is_empty() {
                            t.relative_filename.as_ref()
                        } else {
                            t.filename.as_ref()
                        };
                        std::fs::read(local_file(base, relative)?)?
                    };
                    let texture = image_texture(&bytes, true)?;
                    textures.insert(t.element.element_id, texture.clone());
                    Some(texture)
                }
            } else {
                None
            };
            for face in indices[..count * 3].as_chunks::<3>().0 {
                let vertex_ids = face.map(|i| i as usize);
                let vertices = vertex_ids.map(|i| {
                    let p =
                        ufbx::transform_position(&node.geometry_to_world, mesh.vertex_position[i]);
                    DVec3::new(p.x, p.y, p.z)
                });
                let vertex_colors = mesh.vertex_color.exists.then(|| {
                    vertex_ids.map(|i| {
                        let c = mesh.vertex_color[i];
                        DVec3::new(c.x, c.y, c.z) * 255.0
                    })
                });
                let uvs = mesh.vertex_uv.exists.then(|| {
                    vertex_ids.map(|i| {
                        let uv = mesh.vertex_uv[i];
                        DVec2::new(uv.x, uv.y)
                    })
                });
                triangles.push(Triangle {
                    vertices,
                    color,
                    vertex_colors,
                    uvs,
                    texture: texture.clone(),
                });
            }
        }
    }
    ensure!(!triangles.is_empty(), "Model contains no triangles");
    Ok(triangles)
}
struct TemporaryArchive(PathBuf);
impl Drop for TemporaryArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
pub fn archive(path: &Path) -> Result<Vec<Triangle>> {
    archive_with_color(path, 0xf2a93b)
}
fn archive_with_color(path: &Path, color: u32) -> Result<Vec<Triangle>> {
    ensure!(
        std::fs::metadata(path)?.len() <= MAX_BYTES,
        "Archive exceeds 128 MiB"
    );
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path)?)?;
    ensure!(zip.len() <= 64, "Archive contains more than 64 files");
    let dir = TemporaryArchive(
        std::env::temp_dir().join(format!("space-model-{}", uuid::Uuid::new_v4())),
    );
    std::fs::create_dir(&dir.0)?;
    let mut total = 0u64;
    let mut models = Vec::new();
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        ensure!(!file.is_symlink(), "Model archives cannot contain symlinks");
        let relative = file
            .enclosed_name()
            .context("Archive path leaves its folder")?;
        let destination = dir.0.join(&relative);
        if file.is_dir() {
            std::fs::create_dir_all(&destination)?;
            continue;
        }
        total = total
            .checked_add(file.size())
            .context("Archive size overflow")?;
        ensure!(total <= MAX_BYTES, "Expanded archive exceeds 128 MiB");
        std::fs::create_dir_all(destination.parent().unwrap())?;
        let mut bytes = Vec::new();
        file.by_ref().take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 == file.size(),
            "Invalid archive entry size"
        );
        std::fs::write(&destination, bytes)?;
        if is_model(&destination) {
            models.push(destination);
        }
    }
    ensure!(
        models.len() == 1,
        "Archive must contain exactly one .fbx, .glb, .gltf or .stl model"
    );
    read(&models[0], color)
}
pub fn is_model(path: &Path) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| ["fbx", "gltf", "glb", "stl"].contains(&s.to_ascii_lowercase().as_str()))
}
pub fn read(path: &Path, color: u32) -> Result<Vec<Triangle>> {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "gltf" | "glb" => gltf(path),
        "fbx" => fbx(path),
        "zip" => archive_with_color(path, color),
        "stl" => crate::model_import::read_stl(&std::fs::read(path)?, color),
        _ => anyhow::bail!("Choose .zip, .fbx, .glb, .gltf or .stl"),
    }
}
