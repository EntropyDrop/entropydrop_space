pub mod avatar;
pub mod backpack;
pub mod camera;
pub mod commands;
pub mod distant;
pub mod editor;
pub mod entity_edit;
pub mod frame_metrics;
pub mod geometry;
pub mod interaction;
pub mod palette;
pub mod protocol;
pub mod runtime;
pub mod selection;
pub mod storage;
pub mod streaming;
pub mod ui_state;
pub mod visibility;
pub mod world;

/// Finder does not inherit a development shell's PATH. Keep an explicit Node
/// location for the temporary adapters; SPACE_NODE can override it at runtime.
pub fn node_command() -> std::process::Command {
    std::process::Command::new(
        std::env::var("SPACE_NODE").unwrap_or_else(|_| env!("SPACE_BUILD_NODE").to_owned()),
    )
}

#[allow(clippy::large_enum_variant)] // Generated canonical protobuf layout.
pub mod entropydrop {
    pub mod space {
        pub mod inventory {
            pub mod v8 {
                include!(concat!(
                    env!("OUT_DIR"),
                    "/entropydrop.space.inventory.v8.rs"
                ));
            }
        }
        pub mod backpack {
            pub mod v10 {
                include!(concat!(
                    env!("OUT_DIR"),
                    "/entropydrop.space.backpack.v10.rs"
                ));
            }
        }
        pub mod api {
            pub mod v2 {
                include!(concat!(env!("OUT_DIR"), "/entropydrop.space.api.v2.rs"));
            }
        }
    }
}

pub mod model_import;
pub mod text_voxels;

pub mod tutorial;

pub mod resource_transform;

pub mod minimap;

pub mod model_formats;
