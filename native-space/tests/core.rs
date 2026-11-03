use space_native::{
    editor::Editor,
    protocol, storage,
    world::{Cell, Chunk, Manifest, World, WorldSource, color},
};
use std::path::PathBuf;

fn world() -> World {
    let source = WorldSource {
        root: PathBuf::new(),
        manifest: Manifest {
            schema: 1,
            world: "fixture".into(),
            seed: 42,
            generator: 1,
            spawn: [4.0, 5.0, 4.0],
            source_hash: "fixture-hash".into(),
        },
    };
    let mut world = World::new(source);
    world.insert((0, 0), Chunk::empty());
    world
}

#[test]
fn assembly_is_stopped_and_moves_voxels_with_atomic_undo_without_touching_inventory() {
    let mut world = world();
    let mut editor = Editor::default();
    let full = Cell::new(2, 4, 2, false);
    let micro = Cell::new(24, 32, 16, true);
    world.set(full, color(0x123456, 0));
    world.set(micro, color(0xabcdef, 1));
    editor.selection = Some((full, Cell::new(3, 4, 2, false)));
    editor.copy_selection(&world).unwrap();
    let clipboard = protocol::encode(editor.clipboard.as_ref().unwrap()).unwrap();
    assert_eq!(editor.assemble_selection(&mut world).unwrap(), 2);
    assert!(editor.selection.is_none());
    assert_eq!(world.get(full), 0);
    assert_eq!(world.get(micro), 0);
    assert!(editor.backpack.is_empty());
    assert_eq!(
        protocol::encode(editor.clipboard.as_ref().unwrap()).unwrap(),
        clipboard
    );
    let e = &editor.entities[0];
    assert!(!e.running);
    assert_eq!(e.position, [2.0, 4.0, 2.0]);
    let root = e.definition.root.as_ref().unwrap();
    let body = root.body.unwrap();
    assert_eq!(body.r#type, 1);
    assert_eq!(body.use_gravity, Some(false));
    assert_eq!(body.mass, None);
    assert_eq!(body.friction, Some(0.7));
    assert_eq!(root.script, None);
    protocol::validate_entity(&e.definition).unwrap();
    let id = e.id.clone();
    editor.undo(&mut world);
    assert!(editor.entities.is_empty());
    assert_eq!(world.get(full), color(0x123456, 0));
    assert_eq!(world.get(micro), color(0xabcdef, 1));
    editor.redo(&mut world);
    assert_eq!(editor.entities[0].id, id);
    assert!(!editor.entities[0].running);
    assert_eq!(world.get(full), 0);
    assert_eq!(world.get(micro), 0);
}

#[test]
fn failed_assembly_and_body_reselection_preserve_authored_state() {
    use protocol::inventory::BodyConfig;
    let mut world = world();
    let mut editor = Editor::default();
    editor.selection = Some((Cell::new(0, 0, 0, false), Cell::new(0, 0, 0, false)));
    assert!(editor.assemble_selection(&mut world).is_err());
    assert!(editor.entities.is_empty() && editor.undo.is_empty() && world.edits.is_empty());
    let mut body = BodyConfig {
        r#type: 1,
        use_gravity: Some(false),
        ..Default::default()
    };
    assert!(space_native::editor::set_body_type(&mut body, 0));
    assert_eq!(body.use_gravity, Some(true));
    body.use_gravity = Some(false);
    assert!(!space_native::editor::set_body_type(&mut body, 0));
    assert_eq!(body.use_gravity, Some(false));
    assert!(space_native::editor::set_body_type(&mut body, 1));
    assert_eq!(body.use_gravity, Some(false));
}

#[test]
fn near_streaming_cache_matches_every_reference_request_across_boundaries_and_resizes() {
    use space_native::streaming::NearDemand;
    let mut optimized = NearDemand::default();
    let mut reference = NearDemand::default();
    for radius in [2, 7, 12, 3] {
        for (cx, cz) in [
            (0, 0),
            (-1, -1),
            (1023, 127),
            (1024, 128),
            (511, 64),
            (512, 64),
        ] {
            optimized.update(cx, cz, radius, false);
            reference.update(cx, cz, radius, true);
            assert_eq!(optimized.keys, reference.keys);
            assert!(!optimized.complete);
            optimized.complete = true;
            let pointer = optimized.keys.as_ptr();
            optimized.update(cx, cz, radius, false);
            assert!(optimized.complete);
            assert_eq!(optimized.keys.as_ptr(), pointer);
            assert_eq!(optimized.keys, reference.keys);
            // Simulate a failed load / full request queue: demand remains live.
            optimized.complete = false;
            optimized.update(cx, cz, radius, false);
            assert!(!optimized.complete);
        }
    }
}

#[test]
fn shared_typescript_fixtures_preserve_canonical_bytes_in_rust() {
    let fixtures: std::collections::BTreeMap<String, String> =
        serde_json::from_str(include_str!("fixtures/inventory.json")).unwrap();
    for (name, hex) in fixtures {
        let bytes: Vec<u8> = hex
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect();
        let resource = protocol::decode(&bytes).unwrap();
        assert_eq!(protocol::encode(&resource).unwrap(), bytes, "{name}");
    }
}

#[test]
fn standard_edits_clear_micro_detail_and_undo_restores_both_layers() {
    let mut world = world();
    let mut editor = Editor::default();
    let micro = Cell::new(16, 16, 16, true);
    let full = Cell::new(2, 2, 2, false);
    world.set(micro, color(0xabcdef, 0));
    editor.edit(&mut world, [(full, color(0xabcdef, 0))]);
    assert_eq!(world.get(micro), 0);
    assert_ne!(world.get(full), 0);
    editor.undo(&mut world);
    assert_ne!(world.get(micro), 0);
    assert_eq!(world.get(full), 0);
    editor.redo(&mut world);
    assert_eq!(world.get(micro), 0);
    assert_ne!(world.get(full), 0);
    editor.edit(&mut world, [(micro, color(0, 0))]);
    assert_eq!(world.get(micro), 0);
}

#[test]
fn micro_faces_of_same_color_next_to_full_voxel_are_not_lost() {
    let mut world = world();
    let value = color(0xabcdef, 0);
    world.set(Cell::new(2, 2, 2, false), value);
    world.set(Cell::new(24, 16, 16, true), value);
    let faces = world.mesh((0, 0));
    assert_eq!(
        faces.len(),
        11,
        "six full faces and five exposed micro faces"
    );
    assert!(faces.iter().all(|f| f.color == value));
}

#[test]
fn atomic_save_roundtrips_and_rejects_a_different_terrain_source() {
    let dir = std::env::temp_dir().join(format!("space-native-save-{}", uuid::Uuid::new_v4()));
    let path = dir.join("save.json.gz");
    let save = storage::Save {
        schema: 1,
        world: "fixture".into(),
        source_hash: "source-a".into(),
        position: [1.0, 2.0, 3.0],
        edits: vec![(Cell::new(1, 2, 3, false), color(0, 0))],
        ..Default::default()
    };
    storage::save(&path, &save).unwrap();
    assert_eq!(
        storage::load(&path, "fixture", "source-a").unwrap().edits,
        save.edits
    );
    assert!(storage::load(&path, "fixture", "source-b").is_err());
    let mut changed = save;
    changed.position[1] = 7.0;
    storage::save(&path, &changed).unwrap();
    assert_eq!(
        storage::load(&path, "fixture", "source-a")
            .unwrap()
            .position[1],
        7.0
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn item_root_pose_is_extracted_before_native_placement() {
    use protocol::inventory::{self as pb, inventory_resource::Content};
    let mut world = world();
    let mut editor = Editor::default();
    let entity = pb::Entity {
        root: Some(pb::Component {
            id: "root".into(),
            body: Some(Default::default()),
            blocks: vec![Default::default()],
            local_position: Some(pb::Vector3 {
                x: 2.0,
                y: 3.0,
                z: 4.0,
            }),
            local_rotation: Some(pb::Quaternion {
                x: 0.0,
                y: 1.0,
                z: 0.0,
                w: 0.0,
            }),
            ..Default::default()
        }),
        ..Default::default()
    };
    let item = pb::InventoryResource {
        schema_version: 8,
        content: Some(Content::Item(pb::Item {
            id: "fixture".into(),
            entity_list: vec![entity],
            ..Default::default()
        })),
    };
    editor
        .place(&mut world, &item, glam::DVec3::new(10.0, 20.0, 30.0))
        .unwrap();
    let placed = &editor.entities[0];
    assert_eq!(placed.position, [12.0, 23.0, 34.0]);
    assert_eq!(placed.rotation, [0.0, 1.0, 0.0, 0.0]);
    assert!(
        placed
            .definition
            .root
            .as_ref()
            .unwrap()
            .local_position
            .is_none()
    );
}

#[test]
fn paste_preflight_is_atomic_when_a_chunk_is_missing() {
    use protocol::inventory::{self as pb, inventory_resource::Content};
    let mut world = world();
    let mut editor = Editor::default();
    let blockset = pb::InventoryResource {
        schema_version: 8,
        content: Some(Content::BlockSet(pb::BlockSet {
            name: "edge".into(),
            blocks: vec![
                pb::Voxel {
                    color_rgb: 1,
                    ..Default::default()
                },
                pb::Voxel {
                    dx: 16,
                    color_rgb: 1,
                    ..Default::default()
                },
            ],
        })),
    };
    assert!(
        editor
            .place(&mut world, &blockset, glam::DVec3::ZERO)
            .is_err()
    );
    assert!(world.edits.is_empty());
}

#[test]
fn selection_copy_wraps_across_torus_seam() {
    let mut world = world();
    world.insert((1023, 0), Chunk::empty());
    let mut editor = Editor::default();
    let a = Cell::new(16383, 10, 1, false);
    let b = Cell::new(0, 10, 1, false);
    world.set(a, color(1, 0));
    world.set(b, color(2, 0));
    editor.selection = Some((a, b));
    editor.copy_selection(&world).unwrap();
    let Some(protocol::inventory::inventory_resource::Content::BlockSet(b)) =
        editor.clipboard.unwrap().content
    else {
        panic!()
    };
    assert_eq!(b.blocks.len(), 2);
    let mut xs: Vec<_> = b.blocks.iter().map(|v| v.dx).collect();
    xs.sort();
    assert_eq!(xs, vec![0, 1]);
}

#[test]
fn rust_process_bridge_receives_native_component_geometry() {
    use space_native::{
        editor::PlacedEntity,
        runtime::{Input, Runtime},
    };
    use std::io::Write;
    let mut world = world();
    let dir = std::env::temp_dir().join(format!("space-native-ipc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(dir.join("chunks")).unwrap();
    world.source.root = dir.clone();
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec(&world.source.manifest).unwrap(),
    )
    .unwrap();
    let mut data = vec![0_u8; 16 + 65536 * 4];
    data[..4].copy_from_slice(b"SPC1");
    let mut zip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    zip.write_all(&data).unwrap();
    std::fs::write(dir.join("chunks/0_0.bin.gz"), zip.finish().unwrap()).unwrap();
    let resource = protocol::decode(include_bytes!("../examples/entity.edpb")).unwrap();
    let Some(protocol::inventory::inventory_resource::Content::Entity(definition)) =
        resource.content
    else {
        panic!()
    };
    let entities = vec![PlacedEntity::new(
        definition,
        glam::DVec3::new(4.0, 5.0, 4.0),
    )];
    let mut runtime = Runtime::new(&dir);
    runtime
        .submit(
            &world,
            &entities,
            1,
            Input {
                steps: 0,
                down: Vec::new(),
                player: [4.0, 10.0, 4.0],
                driver: None,
            },
        )
        .unwrap();
    let frame = runtime
        .responses
        .recv_timeout(std::time::Duration::from_secs(30))
        .unwrap()
        .unwrap();
    assert_eq!(frame.entities.len(), 1);
    assert_eq!(frame.entities[0].nodes.len(), 2);
    assert!(
        frame.entities[0]
            .nodes
            .iter()
            .all(|n| n.model.iter().all(|v| v.is_finite()))
    );
    assert!(frame.entities[0].nodes.iter().all(|n| n.voxels.is_some()));
    drop(runtime);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn torus_view_matches_production_web_at_seams_and_transition() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/torus-view.json")).unwrap();
    let vector = |v: &serde_json::Value| {
        glam::DVec3::new(
            v[0].as_f64().unwrap(),
            v[1].as_f64().unwrap(),
            v[2].as_f64().unwrap(),
        )
    };
    for row in fixture["cases"].as_array().unwrap() {
        let actual =
            space_native::geometry::bend_for_view(vector(&row["point"]), vector(&row["camera"]));
        assert!(
            actual.distance(vector(&row["expected"])) < 1e-6,
            "{row}: {actual}"
        );
    }
}
#[test]
fn metal_frustum_keeps_intersections_and_rejects_behind_camera() {
    use glam::{Mat4, Vec3};
    use space_native::geometry::sphere_in_frustum;
    let clip = Mat4::perspective_rh(70_f32.to_radians(), 16.0 / 9.0, 0.1, 100.0);
    assert!(sphere_in_frustum(clip, Vec3::new(0.0, 0.0, -5.0), 1.0));
    assert!(sphere_in_frustum(clip, Vec3::new(0.0, 0.0, -100.0), 1.0));
    assert!(!sphere_in_frustum(clip, Vec3::new(0.0, 0.0, 5.0), 1.0));
    assert!(!sphere_in_frustum(clip, Vec3::new(0.0, 0.0, -110.0), 1.0));
    assert!(!sphere_in_frustum(clip, Vec3::new(100.0, 0.0, -5.0), 1.0));
}
#[test]
fn distant_adapter_preserves_production_voxel_mips_and_bounded_requests() {
    use std::io::Write;
    let dir = std::env::temp_dir().join(format!("space-native-lod-{}", uuid::Uuid::new_v4()));
    let mut source = world().source;
    source.root = dir.clone();
    let cache = dir.join("distant").join(&source.manifest.source_hash);
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(
        dir.join("manifest.json"),
        serde_json::to_vec(&source.manifest).unwrap(),
    )
    .unwrap();
    let mut data = vec![b'V', b'X', b'L', b'7', 7, 0, 0, 0];
    for size in [1_u32, 2, 4, 8, 16, 32, 64] {
        data.extend_from_slice(&size.to_le_bytes());
        data.extend_from_slice(&1_u32.to_le_bytes());
        let mut face = [0_u8; 16];
        face[2..4].copy_from_slice(&8_u16.to_le_bytes());
        face[6..8].copy_from_slice(&8_u16.to_le_bytes());
        face[8..10].copy_from_slice(&8_u16.to_le_bytes());
        face[10] = 3;
        face[12..15].copy_from_slice(&[255, 128, 0]);
        data.extend_from_slice(&face);
    }
    let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gzip.write_all(&data).unwrap();
    let data = gzip.finish().unwrap();
    for x in 0..32 {
        for z in 0..4 {
            std::fs::write(cache.join(format!("{x}_{z}.vxl.gz")), &data).unwrap();
        }
    }
    let mut distant = space_native::distant::Distant::new(source);
    let view = space_native::distant::View {
        camera: [256.0, 64.0, 256.0],
        height: 720,
        torus: false,
        edits: Vec::new(),
    };
    distant.request(view.clone());
    distant.request(view.clone());
    let frame = distant
        .responses
        .recv_timeout(std::time::Duration::from_secs(30))
        .unwrap()
        .unwrap();
    assert_eq!(frame.zones, 1);
    assert_eq!(frame.stats["requestedAreaPx2"], 1);
    let faces: Vec<_> = frame
        .tiles
        .iter()
        .flat_map(|t| {
            t.data
                .iter()
                .map(|f| f.unpack(glam::Vec3::from_array(t.origin)))
        })
        .collect();
    assert!(
        frame
            .tiles
            .iter()
            .all(|t| t.visibility.len() == t.faces.div_ceil(16))
    );
    assert_eq!(faces.len(), 1);
    assert_eq!(faces[0].axis, 3);
    assert_eq!(faces[0].padding, 3);
    assert_eq!(faces[0].color >> 24, 1);
    assert!(distant.responses.try_recv().is_err());
    distant.busy = false;
    distant.request(view);
    assert_eq!(
        distant
            .responses
            .recv_timeout(std::time::Duration::from_secs(30))
            .unwrap()
            .unwrap()
            .zones,
        2
    );
    drop(distant);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn continuous_strokes_and_fractional_micro_paste_preserve_undo() {
    let mut world = world();
    let mut editor = Editor::default();
    let a = Cell::new(1, 1, 1, false);
    let b = Cell::new(2, 1, 1, false);
    editor.begin_stroke();
    editor.edit(&mut world, [(a, color(0x123456, 0))]);
    editor.edit(&mut world, [(b, color(0xabcdef, 1))]);
    editor.end_stroke();
    assert_eq!(editor.undo.len(), 1);
    editor.undo(&mut world);
    assert_eq!(world.get(a), 0);
    assert_eq!(world.get(b), 0);
    editor.redo(&mut world);
    assert_eq!(world.get(a), color(0x123456, 0));
    let r = protocol::inventory::InventoryResource {
        schema_version: 8,
        content: Some(protocol::inventory::inventory_resource::Content::BlockSet(
            protocol::inventory::BlockSet {
                name: "micro".into(),
                blocks: vec![protocol::inventory::Voxel {
                    is_micro: true,
                    color_rgb: 0xabcdef,
                    ..Default::default()
                }],
            },
        )),
    };
    editor
        .place(&mut world, &r, glam::DVec3::new(4.125, 4.25, 4.375))
        .unwrap();
    assert_eq!(world.get(Cell::new(33, 34, 35, true)), color(0xabcdef, 0));
    editor.undo(&mut world);
    assert_eq!(world.get(Cell::new(33, 34, 35, true)), 0);
}
