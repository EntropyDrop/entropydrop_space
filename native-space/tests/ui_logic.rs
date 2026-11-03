use glam::{DQuat, DVec3, IVec3};
use prost::Message;
use space_native::{
    backpack::{Backpack, Category},
    editor::{Editor, PlacedEntity, SelectionAction},
    entity_edit, palette,
    protocol::{self, backpack as wire, inventory as pb},
    selection::{SelectionShape, Shape},
    world::{Cell, Chunk, Manifest, World, WorldSource},
};

fn world() -> World {
    let mut w = World::new(WorldSource {
        root: std::env::temp_dir(),
        manifest: Manifest {
            schema: 1,
            world: "ui-fixture".into(),
            seed: 42,
            generator: 1,
            source_hash: "fixture".into(),
            spawn: [4.0, 8.0, 4.0],
        },
    });
    w.insert((0, 0), Chunk::empty());
    w
}
fn component(id: &str) -> pb::Component {
    pb::Component {
        id: id.into(),
        name: id.into(),
        body: Some(entity_edit::stopped_body()),
        blocks: vec![pb::Voxel {
            color_rgb: 0xabcdef,
            ..Default::default()
        }],
        ..Default::default()
    }
}
fn entity() -> PlacedEntity {
    let mut root = component("root");
    let mut arm = component("arm");
    arm.local_position = Some(entity_edit::pb_vector(DVec3::new(2.0, 0.0, 0.0)));
    root.children.push(arm);
    PlacedEntity::new(
        pb::Entity {
            root: Some(root),
            constraints: vec![],
        },
        DVec3::new(4.0, 4.0, 4.0),
    )
}
fn resource(name: &str) -> pb::InventoryResource {
    pb::InventoryResource {
        schema_version: 8,
        content: Some(pb::inventory_resource::Content::BlockSet(pb::BlockSet {
            name: name.into(),
            blocks: component("block").blocks,
        })),
    }
}

#[test]
fn native_shapes_and_gradients_match_web_golden_data() {
    let fixtures: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/ui.json")).unwrap();
    for row in fixtures["shapes"].as_array().unwrap() {
        let shape: Shape = serde_json::from_value(row["shape"].clone()).unwrap();
        let selection = SelectionShape {
            shape,
            cylinder_axis: row["axis"].as_u64().unwrap() as usize,
            stairs: serde_json::from_value(row["stairs"].clone()).unwrap(),
        };
        let a: [i32; 3] = serde_json::from_value(row["a"].clone()).unwrap();
        let b: [i32; 3] = serde_json::from_value(row["b"].clone()).unwrap();
        let mut actual: Vec<_> = selection
            .cells(IVec3::from_array(a), IVec3::from_array(b), 262144)
            .unwrap()
            .into_iter()
            .map(|v| v.to_array())
            .collect();
        let mut expected: Vec<[i32; 3]> = serde_json::from_value(row["cells"].clone()).unwrap();
        actual.sort();
        expected.sort();
        assert_eq!(actual, expected, "{shape:?} {a:?} {b:?}");
    }
    for row in fixtures["palettes"].as_array().unwrap() {
        let entry = pb::PaletteEntry {
            stops: serde_json::from_value(row["stops"].clone()).unwrap(),
            material_id: 0,
        };
        for sample in row["samples"].as_array().unwrap() {
            assert_eq!(
                palette::sample(&entry, sample["t"].as_f64().unwrap()),
                sample["color"].as_u64().unwrap() as u32
            );
        }
    }
    assert!(
        SelectionShape::default()
            .cells(IVec3::ZERO, IVec3::splat(10000), 65536)
            .is_err()
    );
}
#[test]
fn micro_selection_of_a_full_voxel_is_virtual_and_undo_is_exact() {
    let mut w = world();
    let parent = Cell::new(2, 2, 2, false);
    w.set(parent, 0x01abcdef);
    let mut e = Editor::default();
    e.selection = Some((Cell::new(16, 16, 16, true), Cell::new(17, 17, 17, true)));
    e.copy_selection(&w).unwrap();
    assert_eq!(w.get(parent), 0x01abcdef);
    let Some(pb::inventory_resource::Content::BlockSet(b)) = &e.clipboard.as_ref().unwrap().content
    else {
        panic!()
    };
    assert_eq!(b.blocks.len(), 8);
    assert!(b.blocks.iter().all(|v| v.is_micro));
    e.change_selection(&mut w, SelectionAction::Erase).unwrap();
    assert_eq!(w.get(parent), 0);
    assert_eq!(w.chunks[&(0, 0)].micro.len(), 504);
    e.undo(&mut w);
    assert_eq!(w.get(parent), 0x01abcdef);
    assert!(w.chunks[&(0, 0)].micro.is_empty());
    e.assemble_selection(&mut w).unwrap();
    assert_eq!(
        e.entities[0].definition.root.as_ref().unwrap().blocks.len(),
        8
    );
    e.undo(&mut w);
    assert!(e.entities.is_empty());
    assert_eq!(w.get(parent), 0x01abcdef);
    e.redo(&mut w);
    assert_eq!(e.entities.len(), 1);
    assert_eq!(w.chunks[&(0, 0)].micro.len(), 504);
}
#[test]
fn backpack_keeps_gaps_selected_slots_and_legacy_hotbar_priority() {
    let mut backpack = Backpack::default();
    backpack
        .replace(Category::Items, 197, Some(resource("last")))
        .unwrap();
    backpack.select(Category::Items, 197).unwrap();
    let decoded = Backpack::decode(&backpack.encode().unwrap()).unwrap();
    assert_eq!(
        decoded
            .get(Category::Items, 197)
            .map(space_native::backpack::name),
        Some("last".into())
    );
    assert!(decoded.get(Category::Items, 0).is_none());
    backpack.swap(Category::Items, 197, 4).unwrap();
    assert_eq!(backpack.selected(Category::Items), 4);
    assert!(backpack.get(Category::Items, 197).is_none());
    let mut block_slots = vec![wire::BackpackSlot::default(); 99];
    block_slots[0].resource = Some(resource("block0"));
    block_slots[98].resource = Some(resource("block98"));
    let mut entity_slots = vec![wire::BackpackSlot::default(); 99];
    entity_slots[0].resource = Some(resource("entity0"));
    entity_slots[98].resource = Some(resource("entity98"));
    let old = wire::LegacyBackpack {
        schema_version: 9,
        active_category: 1,
        block_sets: Some(wire::InventoryGroup {
            selected: 98,
            slots: block_slots,
        }),
        entities: Some(wire::InventoryGroup {
            selected: 98,
            slots: entity_slots,
        }),
        color_sets: None,
    };
    let migrated = Backpack::decode(&old.encode_to_vec()).unwrap();
    for (slot, name) in [
        (0, "entity0"),
        (9, "block0"),
        (107, "entity98"),
        (197, "block98"),
    ] {
        assert_eq!(
            space_native::backpack::name(migrated.get(Category::Items, slot).unwrap()),
            name
        );
    }
    assert_eq!(migrated.selected(Category::Items), 107);
    assert!(migrated.get(Category::Items, 1).is_none());
}
#[test]
fn component_edits_preserve_world_poses_and_entity_history() {
    let mut w = world();
    let mut editor = Editor::default();
    let original = entity();
    editor.entities.push(original.clone());
    editor
        .update_entity(0, |e| {
            entity_edit::rename(&mut e.definition, "arm", "root:wheel")?;
            Ok(())
        })
        .unwrap();
    editor.undo(&mut w);
    assert_eq!(editor.entities[0], original);
    editor.redo(&mut w);
    let world_before = entity_edit::pose(&editor.entities[0])
        * entity_edit::matrix(
            editor.entities[0].definition.root.as_ref().unwrap(),
            "root:wheel",
        )
        .unwrap();
    editor.detach_component(0, "root:wheel").unwrap();
    assert_eq!(editor.entities.len(), 2);
    assert!(entity_edit::pose(&editor.entities[1]).abs_diff_eq(world_before, 1e-9));
    editor.undo(&mut w);
    assert_eq!(editor.entities.len(), 1);
    editor.redo(&mut w);
    editor.attach_entity(0, 1, "root").unwrap();
    assert_eq!(editor.entities.len(), 1);
    protocol::validate_entity(&editor.entities[0].definition).unwrap();
    editor.undo(&mut w);
    assert_eq!(editor.entities.len(), 2);
    editor.redo(&mut w);
    assert_eq!(editor.entities.len(), 1);
    let before = editor.entities.clone();
    assert!(
        editor
            .update_entity(0, |e| entity_edit::reparent(
                &mut e.definition,
                "root",
                "root:wheel"
            ))
            .is_err()
    );
    assert_eq!(editor.entities, before);
    editor
        .update_entity(0, |e| {
            e.rotation = DQuat::from_rotation_y(std::f64::consts::FRAC_PI_2).to_array();
            Ok(())
        })
        .unwrap();
    editor.disassemble(&mut w, 0).unwrap();
    assert!(editor.entities.is_empty());
    assert_ne!(w.get(Cell::new(4, 4, 3, false)), 0);
    editor.undo(&mut w);
    assert_eq!(editor.entities.len(), 1);
    assert_eq!(w.get(Cell::new(4, 4, 3, false)), 0);
}

#[test]
fn mixed_copy_cut_and_item_placement_are_atomic_and_keep_constraints() {
    use space_native::commands::Command;
    let mut world = world();
    let mut editor = Editor::default();
    let cell = Cell::new(2, 3, 2, false);
    world.set(cell, space_native::world::color(0x123456, 0));
    let mut e = entity();
    e.definition.constraints.push(pb::EntityConstraint {
        id: "world-pin".into(),
        body_b_component_id: "root".into(),
        anchor_a: Some(entity_edit::pb_vector(DVec3::new(4.0, 5.0, 4.0))),
        stiffness: 1.0,
        ..Default::default()
    });
    editor.entities.push(e.clone());
    editor.selection = Some((Cell::new(1, 2, 1, false), Cell::new(8, 8, 8, false)));
    editor.command(&mut world, Command::Cut).unwrap();
    assert_eq!(world.get(cell), 0);
    assert!(editor.entities.is_empty());
    assert_eq!(editor.undo.len(), 1);
    let item = editor.clipboard.clone().unwrap();
    let Some(pb::inventory_resource::Content::Item(i)) = &item.content else {
        panic!()
    };
    assert_eq!(i.entity_list.len(), 1);
    assert_eq!(
        entity_edit::vector(i.entity_list[0].constraints[0].anchor_a.as_ref()),
        DVec3::new(3.0, 3.0, 3.0)
    );
    editor.undo(&mut world);
    assert_eq!(editor.entities[0], e);
    assert_ne!(world.get(cell), 0);
    editor.redo(&mut world);
    editor
        .place(&mut world, &item, DVec3::new(1.0, 2.0, 1.0))
        .unwrap();
    assert_ne!(world.get(cell), 0);
    assert_eq!(
        entity_edit::vector(
            editor.entities[0].definition.constraints[0]
                .anchor_a
                .as_ref()
        ),
        DVec3::new(4.0, 5.0, 4.0)
    );
    editor.undo(&mut world);
    assert!(editor.entities.is_empty());
    assert_eq!(world.get(cell), 0);
    editor.undo(&mut world);
    assert_eq!(editor.entities[0], e);
    assert_ne!(world.get(cell), 0);
}
#[test]
fn continuous_entity_and_terrain_edits_share_one_undo() {
    let mut world = world();
    let mut editor = Editor::default();
    editor.entities.push(entity());
    let original = editor.entities[0].clone();
    editor.begin_stroke();
    for n in 0..4 {
        editor
            .update_entity(0, |e| {
                e.position[0] += 1.0;
                Ok(())
            })
            .unwrap();
        editor.edit(
            &mut world,
            [(
                Cell::new(n, 1, 0, false),
                space_native::world::color(0xabcdef, 0),
            )],
        );
    }
    editor.end_stroke();
    assert_eq!(editor.undo.len(), 1);
    assert_eq!(editor.undo[0].entities.len(), 1);
    editor.undo(&mut world);
    assert_eq!(editor.entities[0], original);
    assert_eq!(world.get(Cell::new(3, 1, 0, false)), 0);
    editor.redo(&mut world);
    assert_eq!(editor.entities[0].position[0], original.position[0] + 4.0);
}
#[test]
fn rotations_preserve_item_world_anchors_once_and_legacy_absolute_anchors() {
    use space_native::resource_transform::rotate;
    let mut e = entity().definition;
    e.constraints.push(pb::EntityConstraint {
        id: "pin".into(),
        body_b_component_id: "root".into(),
        anchor_a: Some(entity_edit::pb_vector(DVec3::new(4.0, 2.0, 1.0))),
        stiffness: 1.0,
        ..Default::default()
    });
    let item = pb::InventoryResource {
        schema_version: 8,
        content: Some(pb::inventory_resource::Content::Item(pb::Item {
            id: "item".into(),
            name: "Item".into(),
            block_set: None,
            entity_list: vec![e.clone()],
        })),
    };
    let rotated = rotate(&item, 1, 1).unwrap();
    let mut editor = Editor::default();
    editor
        .place(&mut world(), &rotated, DVec3::new(10.0, 3.0, 8.0))
        .unwrap();
    assert!(
        (entity_edit::vector(
            editor.entities[0].definition.constraints[0]
                .anchor_a
                .as_ref()
        ) - DVec3::new(9.0, 5.0, 12.0))
        .length()
            < 1e-9
    );
    let standalone = pb::InventoryResource {
        schema_version: 8,
        content: Some(pb::inventory_resource::Content::Entity(e)),
    };
    let rotated = rotate(&standalone, 1, 1).unwrap();
    editor
        .place(&mut world(), &rotated, DVec3::new(10.0, 3.0, 8.0))
        .unwrap();
    assert_eq!(
        entity_edit::vector(
            editor.entities[1].definition.constraints[0]
                .anchor_a
                .as_ref()
        ),
        DVec3::new(4.0, 2.0, 1.0)
    );
    assert!(
        editor.entities[1]
            .definition
            .root
            .as_ref()
            .unwrap()
            .local_rotation
            .is_none()
    );
    let mut rotated = resource("Blocks");
    let original = protocol::encode(&rotated).unwrap();
    for _ in 0..4 {
        rotated = rotate(&rotated, 0, 1).unwrap();
    }
    assert_eq!(protocol::encode(&rotated).unwrap(), original);
}
#[test]
fn native_text_and_tutorial_are_visible_valid_resources() {
    let r = space_native::text_voxels::create("你好\nSpace", 16, true, 0x123456, 1).unwrap();
    protocol::validate(&r).unwrap();
    let Some(pb::inventory_resource::Content::BlockSet(b)) = r.content else {
        panic!()
    };
    assert!(b.blocks.len() > 50);
    assert!(
        b.blocks
            .iter()
            .all(|v| v.is_micro && v.color_rgb == 0x123456 && v.material_id == 1)
    );
    assert!(space_native::text_voxels::create("  ", 16, false, 0, 0).is_err());
    assert!(space_native::text_voxels::create(&"a".repeat(257), 16, false, 0, 0).is_err());
    let mut w = world();
    let mut editor = Editor::default();
    let mut camera = space_native::camera::Camera::new(DVec3::ZERO);
    space_native::tutorial::load(&mut w, &mut editor, &mut camera).unwrap();
    assert_eq!(editor.entities.len(), 2);
    assert!(w.edits.len() > 1000);
    for e in &editor.entities {
        protocol::validate_entity(&e.definition).unwrap();
        assert!(!e.running);
    }
    assert_eq!(camera.position.x, 8190.0);
}
#[test]
fn gltf_stl_and_zip_import_preserve_color_transform_and_reject_bad_archives() {
    use std::io::Write;
    let root = std::env::temp_dir().join(format!("space-import-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let positions: [f32; 9] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let bytes: Vec<u8> = positions.into_iter().flat_map(f32::to_le_bytes).collect();
    std::fs::write(root.join("mesh.bin"), &bytes).unwrap();
    let json = serde_json::json!({"asset":{"version":"2.0"},"buffers":[{"uri":"mesh.bin","byteLength":36}],"bufferViews":[{"buffer":0,"byteLength":36}],"accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}],"materials":[{"pbrMetallicRoughness":{"baseColorFactor":[0.0,1.0,0.0,1.0]}}],"meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0}]}],"nodes":[{"mesh":0,"translation":[3,4,5]}],"scenes":[{"nodes":[0]}],"scene":0});
    std::fs::write(root.join("mesh.gltf"), json.to_string()).unwrap();
    let triangles = space_native::model_formats::gltf(&root.join("mesh.gltf")).unwrap();
    assert_eq!(triangles.len(), 1);
    assert_eq!(triangles[0].vertices[0], DVec3::new(3.0, 4.0, 5.0));
    assert_eq!(triangles[0].color, 0x00ff00);
    let r =
        space_native::model_import::load(&root.join("mesh.gltf"), 2, true, 0xff0000, 0).unwrap();
    let Some(pb::inventory_resource::Content::BlockSet(b)) = r.content else {
        panic!()
    };
    assert!(b.blocks.len() > 50);
    assert!(
        b.blocks
            .iter()
            .all(|v| v.is_micro && v.color_rgb == 0x00ff00)
    );
    let stl = "solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid triangle\n";
    assert_eq!(
        space_native::model_import::read_stl(stl.as_bytes(), 0x123456).unwrap()[0].color,
        0x123456
    );
    let file = std::fs::File::create(root.join("mesh.zip")).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("triangle.stl", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(stl.as_bytes()).unwrap();
    zip.finish().unwrap();
    assert_eq!(
        space_native::model_formats::archive(&root.join("mesh.zip"))
            .unwrap()
            .len(),
        1
    );
    let file = std::fs::File::create(root.join("bad.zip")).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("../escaped.stl", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(stl.as_bytes()).unwrap();
    zip.finish().unwrap();
    assert!(space_native::model_formats::archive(&root.join("bad.zip")).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn pivots_attach_detach_and_preview_preserve_nested_geometry() {
    use glam::{DQuat, DVec3};
    use space_native::{editor::PlacedEntity, entity_edit as tree, interaction};
    let mut entity = PlacedEntity::new(
        pb::Entity {
            root: Some(pb::Component {
                id: "root".into(),
                body: Some(tree::stopped_body()),
                blocks: vec![pb::Voxel {
                    color_rgb: 0xff00ff,
                    ..Default::default()
                }],
                pivot: Some(tree::pb_vector(DVec3::new(0.25, 0.5, 0.75))),
                children: vec![pb::Component {
                    id: "child".into(),
                    body: Some(tree::stopped_body()),
                    blocks: vec![pb::Voxel {
                        dx: 2,
                        color_rgb: 0xffffff,
                        ..Default::default()
                    }],
                    pivot: Some(tree::pb_vector(DVec3::new(2.5, 0.5, 0.5))),
                    local_position: Some(tree::pb_vector(DVec3::new(3.0, 2.0, 1.0))),
                    local_rotation: Some(tree::pb_quaternion(DQuat::from_rotation_y(
                        std::f64::consts::FRAC_PI_2,
                    ))),
                    ..Default::default()
                }],
                ..Default::default()
            }),
            constraints: vec![],
        },
        DVec3::new(100.0, 20.0, 100.0),
    );
    entity.rotation = DQuat::from_rotation_y(std::f64::consts::FRAC_PI_2).to_array();
    let point = |e: &PlacedEntity, id: &str| {
        (tree::pose(e) * tree::matrix(e.definition.root.as_ref().unwrap(), id).unwrap())
            .transform_point3(DVec3::new(2.0, 0.0, 0.0))
    };
    let before = point(&entity, "child");
    tree::set_pivot(&mut entity, "root", DVec3::new(4.0, 3.0, 2.0)).unwrap();
    assert!(point(&entity, "child").distance(before) < 1e-9);
    tree::set_pivot(&mut entity, "child", DVec3::new(1.0, 2.0, 3.0)).unwrap();
    assert!(point(&entity, "child").distance(before) < 1e-9);
    let (remaining, detached) = tree::detach(&entity, "child").unwrap();
    assert!(point(&detached, "child").distance(before) < 1e-9);
    let merged = tree::merge(&remaining, &detached, "root").unwrap();
    assert!(point(&merged, "child").distance(before) < 1e-9);
    let resource = pb::InventoryResource {
        schema_version: 8,
        content: Some(pb::inventory_resource::Content::Entity(
            merged.definition.clone(),
        )),
    };
    let parts = interaction::resource_parts(&resource);
    let child_matrix = tree::matrix(merged.definition.root.as_ref().unwrap(), "child").unwrap();
    assert!(
        parts[1]
            .1
            .as_dmat4()
            .transform_point3(DVec3::ZERO)
            .distance(child_matrix.transform_point3(DVec3::ZERO))
            < 1e-5
    );
}

#[test]
fn script_shortcuts_match_web_and_attached_items_undo_atomically() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/ui.json")).unwrap();
    let reserved: std::collections::HashSet<_> = fixture["reserved"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    for key in (b'A'..=b'Z')
        .map(|c| format!("Key{}", c as char))
        .chain((0..10).map(|i| format!("Digit{i}")))
        .chain(
            [
                "Escape",
                "Enter",
                "Tab",
                "Space",
                "Delete",
                "Backspace",
                "F3",
                "F5",
                "F12",
                "ArrowLeft",
            ]
            .map(str::to_owned),
        )
    {
        assert_eq!(
            space_native::interaction::reserved_script_key(&key),
            reserved.contains(key.as_str()),
            "{key}"
        );
    }
    let mut editor = Editor::default();
    let mut world = world();
    editor.entities.push(entity());
    let before = editor.entities.clone();
    let item = pb::InventoryResource {
        schema_version: 8,
        content: Some(pb::inventory_resource::Content::BlockSet(pb::BlockSet {
            name: "Attached blocks".into(),
            blocks: vec![pb::Voxel {
                color_rgb: 0xffffff,
                ..Default::default()
            }],
        })),
    };
    editor
        .place_in_component(0, "arm", &item, DVec3::new(7.0, 5.0, 4.0))
        .unwrap();
    let root = editor.entities[0].definition.root.as_ref().unwrap();
    let attached = entity_edit::find(root, "arm")
        .unwrap()
        .children
        .last()
        .unwrap();
    let point = (entity_edit::pose(&editor.entities[0])
        * entity_edit::matrix(root, &attached.id).unwrap())
    .transform_point3(DVec3::ZERO);
    assert!(point.distance(DVec3::new(7.0, 5.0, 4.0)) < 1e-8);
    editor.undo(&mut world);
    assert_eq!(editor.entities, before);
}

#[test]
fn fbx_native_parser_and_texture_sampling_keep_authored_surface_data() {
    use space_native::model_import::{Texture, Triangle};
    use std::sync::Arc;
    let dir = std::env::temp_dir().join(format!("space-fbx-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("triangle.fbx");
    std::fs::write(
        &path,
        r#"; FBX 7.4.0 project file
FBXHeaderExtension: { FBXHeaderVersion: 1003
 FBXVersion: 7400
}
Objects: {
 Geometry: 1001, "Geometry::Triangle", "Mesh" {
  Vertices: *9 { a: 0,0,0,1,0,0,0,1,0 }
  PolygonVertexIndex: *3 { a: 0,1,-3 }
 }
 Model: 1002, "Model::Triangle", "Mesh" {
  Version: 232
  Properties70: {
   P: "Lcl Translation", "Lcl Translation", "", "A",2,3,4
  }
 }
}
Connections: {
 C: "OO",1001,1002
 C: "OO",1002,0
}
"#,
    )
    .unwrap();
    let triangles = space_native::model_formats::read(&path, 0xffffff).unwrap();
    assert_eq!(triangles.len(), 1);
    assert!(
        triangles[0]
            .vertices
            .iter()
            .any(|p| p.distance(DVec3::new(2.0, 3.0, 4.0)) < 1e-8)
    );
    let mut t = Triangle {
        vertices: [DVec3::ZERO, DVec3::X, DVec3::Y],
        color: 0xffffff,
        vertex_colors: Some([DVec3::new(0.0, 255.0, 0.0); 3]),
        uvs: Some([glam::DVec2::new(0.25, 0.25); 3]),
        texture: Some(Arc::new(Texture {
            width: 1,
            height: 1,
            rgba: vec![255, 0, 0, 255],
            flip_y: false,
        })),
    };
    assert_eq!(space_native::model_import::sample(&t, DVec3::X), 0xff0000);
    t.texture = Some(Arc::new(Texture {
        width: 1,
        height: 1,
        rgba: vec![255, 0, 0, 0],
        flip_y: false,
    }));
    assert_eq!(space_native::model_import::sample(&t, DVec3::X), 0x00ff00);
    std::fs::remove_dir_all(dir).unwrap();
}
