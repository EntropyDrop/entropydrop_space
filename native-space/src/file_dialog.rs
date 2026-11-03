//! Native file dialogs, called on winit's main thread.
use objc2::MainThreadMarker;
use objc2_app_kit::{NSModalResponseOK, NSOpenPanel, NSSavePanel};
use objc2_foundation::NSString;
use std::path::PathBuf;
pub fn open() -> Option<PathBuf> {
    let panel = NSOpenPanel::openPanel(MainThreadMarker::new()?);
    panel.setCanChooseDirectories(false);
    panel.setCanChooseFiles(true);
    panel.setAllowsMultipleSelection(false);
    if panel.runModal() != NSModalResponseOK {
        return None;
    }
    Some(PathBuf::from(panel.URL()?.path()?.to_string()))
}
pub fn save(name: &str) -> Option<PathBuf> {
    let panel = NSSavePanel::savePanel(MainThreadMarker::new()?);
    panel.setNameFieldStringValue(&NSString::from_str(name));
    if panel.runModal() != NSModalResponseOK {
        return None;
    }
    Some(PathBuf::from(panel.URL()?.path()?.to_string()))
}
