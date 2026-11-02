# Tutorial level

Open the controls screen and choose **Tutorial** to open it in a new tab,
or add `?tutorial=1` to the game URL. This works in the online and offline builds
without account admission or server APIs.

The base world is a torus with a constant ground height (top surface at Y=17),
generated in the browser by terrain generator version 9. Gray and off-white
blocks alternate in a one-block checkerboard across the ground. No terrain decorations
or hills are generated. The fixed 25 by 25 chunk square is centered 128 m ahead
of the saved spawn, along its heading (12 chunks in each direction, 625 total).
This covers the entire straight course, the driving lane and the Modeling station. The
window does not follow the player, and distant terrain is always disabled.
Terrain-distance settings from other worlds do not change the tutorial window.
Entity nameplates appear only within 32 m of the camera in the tutorial, so the
finished Modeling example does not overlay the entry or earlier chapters.

Chapter signs follow roughly 20 m intervals along the initial heading. Chapter 10
has extra space on each side for `self.setSpinYAxisRPM(30)` to appear on
one line: its sign and practice stand move about 5 m farther along the course,
and chapters 11–13, their guides, the driving lane and finish move about 10 m.
Chapter 03 teaches double-tapping Space to toggle flight; chapter 04 teaches
Space to rise and Shift to descend. Landing exits flight.
Run `node client/tools/refresh-tutorial-signs.mjs`
from the repository root to rebuild the clear pixel lettering and spoked wheel. The wheel,
motor stand, chassis assembly workbench, and driving lane follow in that order from chapter 09.
Signs ask players to check STANDARD/MICRO instead of blindly toggling Tab at
every chapter. Tab switches modes when the displayed mode is different.
Chapters 08 and 09 use MICRO selection; chapter 11 uses MICRO Hammer positioning,
and chapter 13 returns to STANDARD selection.
Colored corner blocks identify the selection endpoints without additional HUD labels.
A new click after a completed selection immediately starts the next selection. The horizontal
rotation cylinder and its two corner markers use individual microcells. Run
`node client/tools/refresh-tutorial-micro-practice.mjs` to rebuild it,
the narrow wheel assembly workbench with its vehicle-sized floor guide.
Chapter 09 teaches entity creation with the micro-voxel wheel. It floats
horizontally one metre above the ground and is selected with the default
Y-axis cylinder between the blue and green corners. It has an unbroken tire and eight spokes on its lower face;
the upper half has an open recessed barrel, so the two faces are distinguishable.
Assemble it with `G`: the new entity defaults to stopped and kinematic.
Switch to Wrench (`3`) and hold LMB to carry it directly to **10 CODE**.

Chapter 10 directly programs `self.setSpinYAxisRPM(30)` to spin around local Y.
The default kinematic body accepts code-driven motion without gravity; no body
type change is needed. Once attached, it follows the chassis.
The sign and the note above the code editor explain that the tutorial demonstrates how entities work;
in the full game, players can ask AI to configure and program entities using
natural language. Agent requests remain unavailable inside the tutorial.
After running the example, press Escape, stop the wheel, choose **Reset rotation**
in its right-click menu, then choose **Cut to backpack**. This saves the complete
wheel with its code before removing the world instance and switches to Hammer.
Take this module forward to **11 INSTALL** to fit the car's one missing wheel.

Chapter 11 provides a stopped, kinematic pickup with its chassis and three wheels
already assembled. The right rear axle, facing the approach from chapter 10, is
empty. The three installed wheels already have the correct spin direction, so the
player's `self.setSpinYAxisRPM(30)` wheel works without any further code edits.
The chassis script stays empty. A single **11 INSTALL** board teaches this attachment.

With Hammer (`2`), check MICRO positioning (Tab if needed). Aim at the empty
silver axle pad: the wheel preview automatically stands upright against that
surface. Press Up twice to turn its hollow face toward the car, then click LMB to
pin the preview. Drag XYZ to center it on the pad and press Enter to install it.
The preview's wave link identifies the parent component. The wheel becomes the
fourth child of the chassis, retaining the code written in chapter 10. Leave the
completed car stopped until chapter 12.

The body is a double-cab off-road pickup with a low hood, four doors, tinted
windows, an open cargo bed, a sport bar and flared wheel arches. It is 9 m long,
4.25 m wide and 3.125 m high, with a 6 m wheelbase and 2 m diameter wheels. The
narrow workbench supports its rails while keeping all tires clear of the floor.
Run `node client/tools/refresh-tutorial-signs.mjs` first to rebuild the lesson 09
wheel, then `node client/tools/refresh-tutorial-chassis.mjs` to rebuild the car
and its three preinstalled wheels without changing the workbench or other lessons.

Chapter 10 first teaches Stop as Wrench (`3`) plus double left-click,
after returning from the editor with Escape;
chapter 12 moves the completed car to the driving lane and aligns it with the lane.
Right-click the car and set **Type: dynamic**, which automatically enables gravity.
The wheels remain kinematic. Start with a Wrench double-click to let the car fall
onto its wheels and drive; double-click again to stop it.
Kinematic wheel scripts drive the dynamic chassis through terrain contact
friction; the chassis needs no thrust script. Keep wheel collision enabled,
use a nonzero wheel friction, and point the car along the lane before starting.
New assemblies default to kinematic; switching a body to dynamic enables gravity.
Existing saved entities retain their authored settings; the provided tutorial chassis
starts kinematic so the player can learn the transition in chapter 12.

Chapter 13 continues straight beyond the driving lane with a 4 by 4 gray terrain
pad and a separate finished sloping-panel example beside it. With Selector (`1`),
check STANDARD mode (Tab if needed), choose Box (`Alt+1`), and click the blue and
green pad corners. Press `G` to assemble the pad; it starts stopped and kinematic.
Press `7`, aim at your assembled pad, then hold and drag RMB and release
to create a panel. Creation selects it automatically; LMB selects it again later. Escape releases the cursor
for the right properties panel: set Dimensions X/Y/Z to `4`, `0.25`, `3` and
Rotation Z to `-30`. Lift it with the Y arrow to clear the base. Modeling produces
visual decorations without collision; the example is not a drivable ramp.
Run `node client/tools/refresh-tutorial-modeling.mjs` to rebuild the terrain pad and separate example.
The finish sign is after this chapter. The fixed terrain window shifts one chunk
forward to cover it while retaining the same 625 chunks and disabled distant terrain.

Run `npm run dev` and open the tutorial on `localhost`, `127.0.0.1` or `[::1]`.
Build the lesson with the normal tools, then click **Save Level** at the top
right. This directly overwrites `client/src/tutorial/tutorial-level.json` through
the local Vite development server. Saving does not reload the current session;
the next entry loads the saved lesson. Rebuild and deploy to publish the change.
Published builds (including offline distributions) have no save button or writer.
Every entry uses the fixed position and heading in the level file's `spawn`,
with a horizontal view. Save Level updates terrain and entities while preserving
that spawn. Moving or looking around while editing does not change the next entry.

The main site's local Vite server also supports saving when it mounts Space.
Register `devTutorialLevel({ root: spaceClientRoot })` in that server's plugins;
the endpoint follows the host's Vite base URL while the destination stays in
the Space project. Keep this plugin development-only and retain its same-origin
loopback checks.

The file contains generator metadata, spawn, sparse standard/micro voxel edits
(including AIR tombstones for removed ground), and all active and dormant
entities, including their scripts and component hierarchy. It excludes generated
terrain, backpacks, account information and network queues. The checked-in file
contains the authored course, the unassembled Modeling pad, the car with three
preinstalled wheels, and the separate finished Modeling example entity.

Every entry creates fresh in-memory terrain/entity storage from the bundled
file. Edits made while playing are temporary, including entity changes, unless
explicitly saved in the local authoring session.
Backpacks use the same persistent browser storage as other worlds on the same
origin and are never included in a lesson.

Market, publishing, hosting, multiplayer, linked worlds, external agents, AI
services and account features show tutorial guidance instead of contacting their
services. Local entity editing, compilation and execution remain available.
