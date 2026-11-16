//! Rust-owned offline UI state. No browser, JavaScript UI store or WebView.
use crate::{backpack::Category, palette::Palette};
use glam::DVec3;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Preferences {
    pub fov: f64,
    pub camera_distance: f64,
    pub minimap: bool,
    pub music: bool,
    pub effects: bool,
    pub particles: bool,
    pub shadows: bool,
    pub distant: bool,
    pub tool_micro: [bool; 3],
    pub palette: Palette,
    pub modeling_size: [f32; 3],
    pub skin_path: Option<String>,
    pub slim_skin: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            fov: 70.0,
            camera_distance: 4.0,
            minimap: true,
            music: false,
            effects: true,
            particles: true,
            shadows: true,
            distant: true,
            tool_micro: [false; 3],
            palette: Palette::default(),
            modeling_size: [0.5; 3],
            skin_path: None,
            slim_skin: false,
        }
    }
}
impl Preferences {
    pub fn normalize(&mut self) {
        self.fov = if self.fov.is_finite() {
            self.fov.clamp(30.0, 120.0)
        } else {
            70.0
        };
        self.camera_distance = if self.camera_distance.is_finite() {
            self.camera_distance.clamp(1.5, 12.0)
        } else {
            4.0
        };
        self.palette.entries.truncate(9);
        while self.palette.entries.len() < 9 {
            self.palette.entries.push(crate::palette::solid(
                crate::palette::PRESETS[self.palette.entries.len()],
                0,
            ));
        }
        for entry in &mut self.palette.entries {
            crate::palette::normalize(entry);
        }
        self.palette.selected = self.palette.selected.min(8);
        for size in &mut self.modeling_size {
            *size = if size.is_finite() {
                size.clamp(0.001, 256.0)
            } else {
                0.5
            };
        }
    }
}
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Modal {
    #[default]
    None,
    Backpack,
    Editor,
    Settings,
    Help,
    Text,
    ModelImport,
    Tutorial,
    ApiDocs,
}
#[derive(Default, Clone, Copy, PartialEq, Eq)]
pub enum EditorTab {
    #[default]
    Script,
    Properties,
    Constraints,
    Console,
}
#[derive(Default, Clone, Copy, PartialEq, Eq)]
pub enum TransformMode {
    #[default]
    Translate,
    Rotate,
    Scale,
    Pivot,
}
#[derive(Clone)]
pub struct ContextMenu {
    pub position: [f32; 2],
    pub entity: Option<String>,
    pub component: Option<String>,
    pub confirm_delete: bool,
}
#[derive(Clone)]
pub struct Placement {
    pub position: DVec3,
    pub rotation: glam::DQuat,
    pub parent: Option<(String, String)>,
}
pub struct UiState {
    pub preferences: Preferences,
    pub modal: Modal,
    pub tab: EditorTab,
    pub context_menu: Option<ContextMenu>,
    pub component: Option<String>,
    pub decoration: Option<String>,
    pub transform: TransformMode,
    pub script_drafts: HashMap<(String, String), String>,
    pub pending_backpack: Option<crate::backpack::Backpack>,
    pub inventory_drag: Option<(Category, usize)>,
    pub inventory_name: String,
    pub color_picker: bool,
    pub active_stop: usize,
    pub placement: Option<Placement>,
    pub attach_source: Option<String>,
    pub brush_corner: Option<crate::selection::ComponentSelection>,
    pub navigation_target: Option<DVec3>,
    pub navigation_input: [String; 3],
    pub nearby_open: bool,
    pub nearby_page: usize,
    pub text: String,
    pub text_size: u32,
    pub text_preview: Option<crate::protocol::inventory::InventoryResource>,
    pub import_resolution: u32,
    pub import_micro: bool,
    pub reparent_target: String,
    pub component_id: String,
    pub selected_constraint: Option<String>,
    pub sidebar_width: f32,
    pub palette_revision: u64,
}
impl Default for UiState {
    fn default() -> Self {
        Self {
            preferences: Default::default(),
            modal: Modal::None,
            tab: EditorTab::Script,
            context_menu: None,
            component: None,
            decoration: None,
            transform: Default::default(),
            script_drafts: HashMap::new(),
            pending_backpack: None,
            inventory_drag: None,
            inventory_name: String::new(),
            color_picker: false,
            active_stop: 0,
            placement: None,
            attach_source: None,
            brush_corner: None,
            navigation_target: None,
            navigation_input: [String::new(), String::new(), String::new()],
            nearby_open: false,
            nearby_page: 0,
            text: String::new(),
            text_size: 16,
            text_preview: None,
            import_resolution: 12,
            import_micro: false,
            reparent_target: String::new(),
            component_id: String::new(),
            selected_constraint: None,
            sidebar_width: 220.0,
            palette_revision: 0,
        }
    }
}
impl UiState {
    pub fn open(&mut self, modal: Modal) {
        self.context_menu = None;
        self.modal = modal;
    }
    pub fn escape(&mut self) -> bool {
        if self.attach_source.take().is_some() {
            return true;
        }
        if self.brush_corner.take().is_some() {
            return true;
        }
        if self.context_menu.take().is_some() {
            return true;
        }
        if self.color_picker {
            self.color_picker = false;
            return true;
        }
        if self.modal == Modal::ApiDocs {
            self.modal = Modal::Editor;
            return true;
        }
        if self.modal != Modal::None {
            self.modal = Modal::None;
            return true;
        }
        if self.placement.take().is_some() {
            return true;
        }
        false
    }
}
