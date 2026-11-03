# Rust offline UI and interaction migration

The desktop window, UI state, input routing and authored editing commands now run
in Rust. The UI uses egui through the existing Metal renderer; it does not embed a
WebView, React, or the Web UI store. Layout follows the Web pixel theme: status at
top left, quick actions and minimap at top right, a seven-tool belt at the bottom,
and modal editors. Narrow windows move navigation above the tool belt.

This is an offline singleplayer client. Accounts, multiplayer, market and server
execution are intentionally outside this scope. The rendering preset remains
Ultra (native resolution, 4x MSAA, 4096 shadow map and the existing postprocess chain).

## Native surfaces and commands

| Surface | Rust implementation |
| --- | --- |
| Startup/help | Controls, play and tutorial entry; modal focus and cursor capture |
| Tool belt | Seven tools, per-tool standard/micro grid, keyboard and mouse routing |
| Selector | Box, cylinder, sphere, stairs, line, connected terrain selection, component selection, rotation, fill/paint/erase, mixed terrain/entity copy and cut, assembly |
| Hammer | Backpack items, translucent preview, click to pin, XYZ dragging/numeric position, Enter to commit, cancel, quarter-turn rotation; Shift-click attaches to a component |
| Wrench | Hold to carry, wheel distance, double-click run/stop, context menu, XYZ movement/rotation/pivot, attach, detach, duplicate, disassemble |
| Shovel/spoon/brush | Continuous standard/micro edits, component edits, one undo per stroke; brush right-click region selection |
| Modeling | Decoration selection, right-drag creation, left-drag movement, XYZ translation/rotation/scale, duplicate/delete, property inspector |
| Palette | Nine entries, 1–5 gradient stops, RGB, material, color set import/export |
| Backpack | v10 Items 198 / Color sets 99, fixed nine-slot hotbar, scrollable storage, drag/swap, rename/duplicate/delete, portable resources and full-backpack import/export; explicit replacement confirmation |
| Entity editor | Component tree, orbitable/pickable model preview, script editor, API source reference, console, properties; hierarchy changes, body settings, seats, decorations, point/hinge/weld constraints |
| Import | GLB/GLTF, FBX, binary/ASCII STL and ZIP; native texture/vertex color sampling, background conversion, bounded file/resource/work/output sizes |
| Text | Bundled pixel font, CJK and Latin, size, standard/micro voxels, preview and Hammer handoff |
| Settings | FOV, third-person distance, perspective, local world, flight, near radius, VSync, minimap, music/effects, custom/default/slim skin, explicit save and screenshot |
| Navigation | Coordinates, torus-wrapped travel, spawn/stop, manual movement cancellation, cached resident-terrain minimap with click navigation |
| Tutorial | Separate local tutorial world, course terrain, two example entities, thirteen chapter destinations and nearby nameplates; tutorial never overwrites normal-world saves |
| History | Combined terrain/entity transactions, whole continuous strokes and transforms, atomic copy/cut/place/attach/assemble/detach/disassemble |
| Driving/script interaction | Aim-based seat selection, fixed seat orientation, dismount, movement key release on focus loss, Web reserved-key filtering, bounded clicked-block events |
| Local audio | Background OGG decoded in Rust, native playback, procedural tool effects; music defaults off |

## Boundaries and visual differences

Terrain generation, volume LOD planning, physical simulation and AssemblyScript
compilation/execution still use the existing bounded Node/AssemblyScript adapter.
Rust determines the input events and edits; the adapter consumes simulation
requests and returns poses, changed geometry and script results. Replacing those
engine implementations is a separate phase, not part of this UI migration.

The code editor is a native text editor, not Monaco: it does not yet provide
language-server completion or compiler source navigation. Inventory thumbnails
and the component preview are lightweight native previews, not the full Ultra
world pipeline. The minimap uses currently resident terrain. Render quality is
fixed to Ultra rather than exposing Web's entire quality preset matrix. Tool
sounds are native procedural equivalents. Particle effects and scripted audio
remain engine/rendering follow-up work. Native accessibility and IME composition
need broader platform testing; pasted CJK text has been checked in the window.

World and component selection outlines currently show their enclosing bounds;
the selected cell set uses the actual shape. The existing Rust player collision
solver still has the limitations recorded in MIGRATION.md. This change does not
make the entire game engine a pure Rust implementation or a standalone distributable.

## Persistence and assets

`NativeSave` adds optional `backpack_state` and `preferences`. Legacy backpack
resources remain readable and are also written for backward compatibility.
Backpack protobuf v10 preserves gaps and selected slots, with v8/v9 migration.
Item rotation and placement distinguish Item-relative world anchors from legacy
Entity absolute world anchors. Authored pivot and child transforms are shared by
native preview, attachment, copy and disassembly, with a runtime matrix comparison.

The tutorial protobufs are generated at build/development time using
`node native-space/tools/ui-assets.ts`. They are embedded as native data at runtime.
`tools/ui-font.py` reproduces the TTF from the existing Web WOFF2; its OFL license
is included alongside the font. The music asset is the existing local Web OGG.

## Verification

Validated on 2026-11-03: formatting, Clippy (`-D warnings`), 49 Rust tests,
the adapter TypeScript check and 10 Node tests all pass. Release application
bundles were rebuilt. Window checks covered modal focus, backpack scrolling,
component preview picking, editor layout, CJK text preview, numeric placement,
placement/undo and narrow-window tool-panel layout.

The actual egui axis widget has an input-event regression test for dragging
outside its starting rectangle, plus a test for a move/press arriving before the
next UI frame. OS-level automated drags did not produce a value change in either
the gizmo or a normal numeric drag control, so physical mouse dragging is not
claimed as verified by the window test. Numeric editing was verified in-window.

Run `sh native-space/tools/check.sh` for formatting, Clippy with warnings denied,
Rust tests, the adapter TypeScript check and Node tests. The Rust tests cover:

- 84 Web shape cases and 40 palette samples, plus the reserved input code list;
- component/terrain micro edits, mixed copy/cut and grouped history;
- backpack gaps, v10 round trips and legacy hotbar migration;
- reparenting, pivot changes, attach/detach, world pose preservation and preview/runtime matrix agreement;
- Item quarter turns and world-anchor placement semantics;
- glTF transforms/colors, FBX triangles, STL, texture sampling, ZIP traversal rejection, CJK text and tutorial resources;
- modeling create/drag/cancel and one-step undo.

The Node adapter suite additionally verifies clicked-block delivery/deduplication,
script errors, stable GPU geometry, seats, collision and gravity transitions.

For interactive validation run `sh native-space/tools/ui-validation.sh`, then open
`build/Space UI Validation.app`. This executable detects the validation bundle
path and disables saving even when Finder launches it without environment
variables. `--ui-test` provides the same protection for CLI launches. Normal
`build/Space Native.app` continues to save local play. Do not use the normal bundle
for destructive UI test fixtures.
